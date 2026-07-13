/**
 * CaseRepo — read-only access to a `cases/` root directory.
 *
 * Phase 1 impl is FS-Access-API-backed; the abstract interface keeps an
 * HTTP-backed implementation a drop-in away if we add a backend later.
 *
 * Conventions:
 *   - All paths are relative to the case directory root.
 *   - Reads are lazy; the repo never holds parsed file contents in memory.
 *   - Each list/read returns plain data so consumers can treat the repo as a
 *     pure source. UI state lives in the page hooks, not here.
 */
import { ApiError, apiFetch } from '../../api/apiClient';
import { driverList, inlineUrl } from '../../api/blobClient';

import {
  type BlobRoot,
  fetchHealth,
  getBackendUrl,
  getBlobRoot,
  getBlobSftRoot,
} from './connection';
import {
  type AuditorFiring,
  type CaseBundle,
  type CaseMeta,
  type CaseSummary,
  type DroppedRow,
  type ExtractorFiring,
  type FiringFile,
  type FiringPhase,
  type GraphSnapshot,
  type GraphSnapshotFile,
  type MainAgentMessage,
  type MainTurn,
  type SftRow,
  type SftRowBase,
  type TrajectoryRow,
  type VerdictRow,
  computeCaseLinks,
} from './schemas';

export interface CaseSftBundle {
  extractor: SftRow[];
  auditor: SftRow[];
  dropped: DroppedRow[];
}

export interface CaseRepo {
  /** Cosmetic label shown in headers; not load-bearing. */
  readonly label: string;
  listCases(): Promise<CaseSummary[]>;
  readMeta(caseId: string): Promise<CaseMeta>;
  readMainAgent(caseId: string): Promise<MainAgentMessage[]>;
  listFiringFiles(caseId: string, phase: FiringPhase): Promise<string[]>;
  readFiring(
    caseId: string,
    phase: FiringPhase,
    fileName: string
  ): Promise<FiringFile>;
  readVerdicts(caseId: string): Promise<VerdictRow[]>;
  readTrajectory(caseId: string): Promise<TrajectoryRow[]>;
  /** Cumulative graph state after an extractor firing succeeded.
   * Returns null if the snapshot file is missing (firing didn't advance). */
  readSnapshot(caseId: string, extractorSequence: number): Promise<GraphSnapshotFile | null>;
  /** Compose meta + main + extractor[] + auditor[] + graph snapshots into a
   *  CaseBundle, computing the cross-pane link index in one place. SFT is
   *  excluded (different backends source it differently); pages load it lazily. */
  loadBundle(caseId: string): Promise<CaseBundle>;
  /** Lazy per-case SFT slice. Returns `null` when SFT isn't available for this
   *  backend; callers should render an "SFT not available" state rather than
   *  treat that as an error. */
  loadSftForCase(
    caseId: string,
    sessionId: string,
  ): Promise<CaseSftBundle | null>;
}

function parseFiringFileName(
  name: string,
): { seq: number; turn: number } | null {
  const m = /^(\d+)_turn_(\d+)\.json$/.exec(name);
  if (!m) {
    return null;
  }
  return { seq: Number(m[1]), turn: Number(m[2]) };
}

/** Shared loadBundle body — every CaseRepo implementation parallel-reads
 *  all the files for a case via the interface methods. */
async function loadBundleViaRepo(
  repo: CaseRepo,
  caseId: string,
): Promise<CaseBundle> {
  const [meta, mainRaw, extractorFiles, auditorFiles] = await Promise.all([
    repo.readMeta(caseId),
    repo.readMainAgent(caseId),
    repo.listFiringFiles(caseId, 'extractor'),
    repo.listFiringFiles(caseId, 'auditor'),
  ]);

  const extractorMeta = extractorFiles
    .map((f) => ({ file: f, parsed: parseFiringFileName(f) }))
    .filter(
      (x): x is { file: string; parsed: { seq: number; turn: number } } =>
        x.parsed !== null,
    );
  const auditorMeta = auditorFiles
    .map((f) => ({ file: f, parsed: parseFiringFileName(f) }))
    .filter(
      (x): x is { file: string; parsed: { seq: number; turn: number } } =>
        x.parsed !== null,
    );

  const [extractor, auditor, snapshots] = await Promise.all([
    Promise.all(
      extractorMeta.map(async ({ file }) => {
        const raw = await repo.readFiring(caseId, 'extractor', file);
        return raw as unknown as ExtractorFiring;
      }),
    ),
    Promise.all(
      auditorMeta.map(async ({ file }) => {
        const raw = await repo.readFiring(caseId, 'auditor', file);
        return raw as unknown as AuditorFiring;
      }),
    ),
    Promise.all(
      extractorMeta.map(async ({ parsed }) => ({
        seq: parsed.seq,
        snap: await repo.readSnapshot(caseId, parsed.seq).catch(() => null),
      })),
    ),
  ]);

  extractor.sort((a, b) => a.sequence - b.sequence);
  auditor.sort((a, b) => a.sequence - b.sequence);
  const graphs = new Map<number, GraphSnapshot>();
  for (const { seq, snap } of snapshots) {
    if (snap) {
      graphs.set(seq, snap as GraphSnapshot);
    }
  }

  const main = mainRaw as unknown as MainTurn[];

  const partial: Omit<CaseBundle, 'links'> = {
    meta,
    main,
    extractor,
    auditor,
    graphs,
  };
  return { ...partial, links: computeCaseLinks(partial) };
}

// --------------------------------------------------------------------------
// FS Access API impl
// --------------------------------------------------------------------------

interface FileSystemDirectoryHandleLike {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<
    FileSystemDirectoryHandleLike | FileSystemFileHandleLike
  >;
  getDirectoryHandle(name: string): Promise<FileSystemDirectoryHandleLike>;
  getFileHandle(name: string): Promise<FileSystemFileHandleLike>;
}
interface FileSystemFileHandleLike {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}

async function readTextFile(
  dir: FileSystemDirectoryHandleLike,
  name: string
): Promise<string> {
  const fh = await dir.getFileHandle(name);
  const file = await fh.getFile();
  return file.text();
}

function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    out.push(JSON.parse(line) as T);
  }
  return out;
}

async function readJsonlOrEmpty<T>(
  dir: FileSystemDirectoryHandleLike,
  name: string
): Promise<T[]> {
  try {
    return parseJsonl<T>(await readTextFile(dir, name));
  } catch {
    return [];
  }
}

export class FSAccessCaseRepo implements CaseRepo {
  readonly label: string;
  private root: FileSystemDirectoryHandleLike;

  constructor(root: FileSystemDirectoryHandleLike) {
    this.root = root;
    this.label = root.name;
  }

  private async caseDir(
    caseId: string
  ): Promise<FileSystemDirectoryHandleLike> {
    return this.root.getDirectoryHandle(caseId);
  }

  async listCases(): Promise<CaseSummary[]> {
    const out: CaseSummary[] = [];
    for await (const entry of this.root.values()) {
      if (entry.kind !== 'directory') continue;
      const dir = entry as FileSystemDirectoryHandleLike;
      try {
        const text = await readTextFile(dir, 'meta.json');
        const meta = JSON.parse(text) as CaseMeta;
        out.push({ caseId: dir.name, meta });
      } catch {
        // Skip dirs without a meta.json — not every child is a case.
      }
    }
    out.sort((a, b) => a.caseId.localeCompare(b.caseId));
    return out;
  }

  async readMeta(caseId: string): Promise<CaseMeta> {
    const dir = await this.caseDir(caseId);
    return JSON.parse(await readTextFile(dir, 'meta.json')) as CaseMeta;
  }

  async readMainAgent(caseId: string): Promise<MainAgentMessage[]> {
    const dir = await this.caseDir(caseId);
    return parseJsonl<MainAgentMessage>(
      await readTextFile(dir, 'main_agent.jsonl')
    );
  }

  async listFiringFiles(caseId: string, phase: FiringPhase): Promise<string[]> {
    const dir = await this.caseDir(caseId);
    const phaseDir = await dir.getDirectoryHandle(phase);
    const names: string[] = [];
    for await (const entry of phaseDir.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.json')) {
        names.push(entry.name);
      }
    }
    names.sort();
    return names;
  }

  async readFiring(
    caseId: string,
    phase: FiringPhase,
    fileName: string
  ): Promise<FiringFile> {
    const dir = await this.caseDir(caseId);
    const phaseDir = await dir.getDirectoryHandle(phase);
    const text = await readTextFile(phaseDir, fileName);
    return JSON.parse(text) as FiringFile;
  }

  async readVerdicts(caseId: string): Promise<VerdictRow[]> {
    return readJsonlOrEmpty<VerdictRow>(
      await this.caseDir(caseId),
      'verdicts.jsonl'
    );
  }

  async readTrajectory(caseId: string): Promise<TrajectoryRow[]> {
    return readJsonlOrEmpty<TrajectoryRow>(
      await this.caseDir(caseId),
      'trajectory.jsonl'
    );
  }

  async readSnapshot(
    caseId: string,
    extractorSequence: number
  ): Promise<GraphSnapshotFile | null> {
    const dir = await this.caseDir(caseId);
    try {
      const snapDir = await dir.getDirectoryHandle('event_graph');
      const padded = String(extractorSequence).padStart(3, '0');
      const text = await readTextFile(
        snapDir,
        `after_extractor_${padded}.json`
      );
      return JSON.parse(text) as GraphSnapshotFile;
    } catch {
      return null;
    }
  }

  loadBundle(caseId: string): Promise<CaseBundle> {
    return loadBundleViaRepo(this, caseId);
  }

  async loadSftForCase(caseId: string): Promise<CaseSftBundle | null> {
    const dir = await this.caseDir(caseId);
    let sftDir: FileSystemDirectoryHandleLike;
    try {
      sftDir = await dir.getDirectoryHandle('sft');
    } catch {
      return null;
    }
    const [extractor, auditor, dropped] = await Promise.all([
      readJsonlOrEmpty<SftRow>(sftDir, 'extractor.jsonl'),
      readJsonlOrEmpty<SftRow>(sftDir, 'auditor.jsonl'),
      readJsonlOrEmpty<DroppedRow>(sftDir, 'dropped.jsonl'),
    ]);
    if (extractor.length === 0 && auditor.length === 0 && dropped.length === 0) {
      return null;
    }
    return { extractor, auditor, dropped };
  }
}

// --------------------------------------------------------------------------
// Browser hookup: pick a directory + remember the handle across reloads.
// --------------------------------------------------------------------------

interface ShowDirectoryPickerFn {
  (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
  }): Promise<FileSystemDirectoryHandleLike>;
}

declare global {
  interface Window {
    showDirectoryPicker?: ShowDirectoryPickerFn;
  }
}

const IDB_NAME = 'aegis-llmharness-review';
const IDB_STORE = 'handles';
const IDB_KEY = 'cases-root';
const IDB_KEY_SFT = 'sft-root';

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key: string): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function isFsAccessSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.showDirectoryPicker === 'function'
  );
}

interface PersistedRootHelpers<R> {
  pick: () => Promise<R>;
  restore: () => Promise<R | null>;
  clear: () => Promise<void>;
}

function createPersistedRoot<R>(
  pickerId: string,
  idbKey: string,
  wrap: (handle: FileSystemDirectoryHandleLike) => R
): PersistedRootHelpers<R> {
  const fsUnavailable = new Error(
    'File System Access API is not available in this browser.'
  );

  return {
    async pick() {
      const picker = isFsAccessSupported()
        ? window.showDirectoryPicker
        : undefined;
      if (!picker) throw fsUnavailable;
      const handle = await picker({ id: pickerId, mode: 'read' });
      await idbSet(idbKey, handle);
      return wrap(handle);
    },
    async restore() {
      if (!isFsAccessSupported()) return null;
      const handle = await idbGet<FileSystemDirectoryHandleLike>(idbKey);
      if (!handle) return null;
      const queryable = handle as unknown as {
        queryPermission?: (opts: { mode: 'read' }) => Promise<PermissionState>;
        requestPermission?: (opts: {
          mode: 'read';
        }) => Promise<PermissionState>;
      };
      if (queryable.queryPermission) {
        const state = await queryable.queryPermission({ mode: 'read' });
        if (state !== 'granted') {
          const next = queryable.requestPermission
            ? await queryable.requestPermission({ mode: 'read' })
            : state;
          if (next !== 'granted') return null;
        }
      }
      return wrap(handle);
    },
    async clear() {
      await idbDelete(idbKey);
    },
  };
}

const casesRoot = createPersistedRoot(
  'aegis-cases-root',
  IDB_KEY,
  (h) => new FSAccessCaseRepo(h)
);

export const pickCasesRoot = casesRoot.pick;
export const restoreCasesRoot = casesRoot.restore;
export const clearStoredRoot = casesRoot.clear;

// --------------------------------------------------------------------------
// SftRepo — sibling 'sft/' directory holding extractor/auditor/dropped JSONL.
// --------------------------------------------------------------------------

export interface SftRepo {
  readonly label: string;
  readExtractor(): Promise<SftRowBase[]>;
  readAuditor(): Promise<SftRowBase[]>;
  readDropped(): Promise<DroppedRow[]>;
}

export class FSAccessSftRepo implements SftRepo {
  readonly label: string;
  private root: FileSystemDirectoryHandleLike;

  constructor(root: FileSystemDirectoryHandleLike) {
    this.root = root;
    this.label = root.name;
  }

  readExtractor = (): Promise<SftRowBase[]> =>
    readJsonlOrEmpty<SftRowBase>(this.root, 'extractor.jsonl');
  readAuditor = (): Promise<SftRowBase[]> =>
    readJsonlOrEmpty<SftRowBase>(this.root, 'auditor.jsonl');
  readDropped = (): Promise<DroppedRow[]> =>
    readJsonlOrEmpty<DroppedRow>(this.root, 'dropped.jsonl');
}

export class BlobSftRepo implements SftRepo {
  readonly label: string;
  readonly bucket: string;
  readonly prefix: string;

  constructor(bucket: string, prefix: string) {
    this.bucket = bucket;
    this.prefix = prefix;
    this.label = prefix ? `${bucket}/${prefix.replace(/\/$/, '')}` : bucket;
  }

  private async getJsonlOrEmpty<T>(name: string): Promise<T[]> {
    try {
      const res = await apiFetch(inlineUrl(this.bucket, `${this.prefix}${name}`));
      return parseJsonl<T>(await res.text());
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        return [];
      }
      throw err;
    }
  }

  readExtractor = (): Promise<SftRowBase[]> =>
    this.getJsonlOrEmpty<SftRowBase>('extractor.jsonl');
  readAuditor = (): Promise<SftRowBase[]> =>
    this.getJsonlOrEmpty<SftRowBase>('auditor.jsonl');
  readDropped = (): Promise<DroppedRow[]> =>
    this.getJsonlOrEmpty<DroppedRow>('dropped.jsonl');
}

export function probeBlobSftRepo(): BlobSftRepo | null {
  const root = getBlobSftRoot();
  if (!root) {
    return null;
  }
  return new BlobSftRepo(root.bucket, root.prefix);
}

const sftRoot = createPersistedRoot(
  'aegis-sft-root',
  IDB_KEY_SFT,
  (h) => new FSAccessSftRepo(h)
);

export const pickSftRoot = sftRoot.pick;
export const restoreSftRoot = sftRoot.restore;
export const clearStoredSftRoot = sftRoot.clear;

// --------------------------------------------------------------------------
// HTTP-backed repo — talks to `llmharness serve` on a user-configured URL.
// Lives next to the FSAccess impl so both satisfy the same CaseRepo contract.
// --------------------------------------------------------------------------

export class HttpCaseRepo implements CaseRepo {
  readonly label: string;
  private readonly base: string;

  constructor(baseUrl: string, label?: string) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.label = label ?? new URL(this.base).host;
  }

  private async getJson<T>(path: string): Promise<T> {
    const r = await fetch(`${this.base}${path}`);
    if (!r.ok) {
      throw new Error(`GET ${path} → ${r.status}`);
    }
    return (await r.json()) as T;
  }

  private async getText(path: string): Promise<string> {
    const r = await fetch(`${this.base}${path}`);
    if (!r.ok) {
      throw new Error(`GET ${path} → ${r.status}`);
    }
    return r.text();
  }

  async listCases(): Promise<CaseSummary[]> {
    const payload = await this.getJson<{
      cases: Array<{ case_id: string; meta: CaseMeta }>;
    }>('/api/cases');
    return payload.cases.map((c) => ({ caseId: c.case_id, meta: c.meta }));
  }

  readMeta(caseId: string): Promise<CaseMeta> {
    return this.getJson<CaseMeta>(
      `/api/cases/${encodeURIComponent(caseId)}/meta`
    );
  }

  async readMainAgent(caseId: string): Promise<MainAgentMessage[]> {
    return parseJsonl<MainAgentMessage>(
      await this.getText(`/api/cases/${encodeURIComponent(caseId)}/main_agent`)
    );
  }

  async listFiringFiles(caseId: string, phase: FiringPhase): Promise<string[]> {
    const payload = await this.getJson<{ files: string[] }>(
      `/api/cases/${encodeURIComponent(caseId)}/firings/${phase}`
    );
    return payload.files;
  }

  readFiring(
    caseId: string,
    phase: FiringPhase,
    fileName: string
  ): Promise<FiringFile> {
    return this.getJson<FiringFile>(
      `/api/cases/${encodeURIComponent(caseId)}/firings/${phase}/${encodeURIComponent(fileName)}`
    );
  }

  async readVerdicts(caseId: string): Promise<VerdictRow[]> {
    try {
      return parseJsonl<VerdictRow>(
        await this.getText(`/api/cases/${encodeURIComponent(caseId)}/verdicts`)
      );
    } catch {
      return [];
    }
  }

  async readTrajectory(caseId: string): Promise<TrajectoryRow[]> {
    try {
      return parseJsonl<TrajectoryRow>(
        await this.getText(
          `/api/cases/${encodeURIComponent(caseId)}/trajectory`
        )
      );
    } catch {
      return [];
    }
  }

  async readSnapshot(
    caseId: string,
    sequence: number
  ): Promise<GraphSnapshotFile | null> {
    try {
      return await this.getJson<GraphSnapshotFile>(
        `/api/cases/${encodeURIComponent(caseId)}/snapshots/${sequence}`
      );
    } catch {
      return null;
    }
  }

  loadBundle(caseId: string): Promise<CaseBundle> {
    return loadBundleViaRepo(this, caseId);
  }

  async loadSftForCase(caseId: string): Promise<CaseSftBundle | null> {
    const r = await fetch(`${this.base}/api/cases/${encodeURIComponent(caseId)}/sft`);
    if (r.status === 404) {
      return null;
    }
    if (!r.ok) {
      throw new Error(`GET /api/cases/${caseId}/sft → ${r.status}`);
    }
    return (await r.json()) as CaseSftBundle;
  }
}

// --------------------------------------------------------------------------
// Blob-backed repo — reads cases out of the platform's aegis-blob storage
// via the same /api/v2/blob surface used by the Blob sub-app. The user
// supplies (bucket, prefix); the repo enumerates case directories under
// that prefix and reads files via inline GETs.
// --------------------------------------------------------------------------

export class BlobCaseRepo implements CaseRepo {
  readonly label: string;
  readonly bucket: string;
  /** Directory prefix inside the bucket. Either empty or ends with '/'. */
  readonly prefix: string;

  constructor(bucket: string, prefix: string) {
    this.bucket = bucket;
    this.prefix = prefix;
    this.label = prefix ? `${bucket}/${prefix.replace(/\/$/, '')}` : bucket;
  }

  /** Path within the bucket for a given case-relative key. */
  private keyFor(caseId: string, suffix: string): string {
    return `${this.prefix}${caseId}/${suffix}`;
  }

  private async getText(key: string): Promise<string> {
    const res = await apiFetch(inlineUrl(this.bucket, key));
    return res.text();
  }

  private async getJson<T>(key: string): Promise<T> {
    return JSON.parse(await this.getText(key)) as T;
  }

  private async getJsonlOrEmpty<T>(key: string): Promise<T[]> {
    try {
      return parseJsonl<T>(await this.getText(key));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        return [];
      }
      throw err;
    }
  }

  private async listChildDirs(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const page = await driverList(this.bucket, {
        prefix,
        delimiter: '/',
        max_keys: 1000,
        continuation_token: token,
      });
      for (const cp of page.common_prefixes ?? []) {
        const rel = cp.slice(prefix.length).replace(/\/$/, '');
        if (rel) {
          out.push(rel);
        }
      }
      token = page.next_continuation_token;
    } while (token);
    return out;
  }

  private async listChildFiles(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const page = await driverList(this.bucket, {
        prefix,
        delimiter: '/',
        max_keys: 1000,
        continuation_token: token,
      });
      for (const item of page.items) {
        const name = item.key.slice(prefix.length);
        if (name && !name.includes('/')) {
          out.push(name);
        }
      }
      token = page.next_continuation_token;
    } while (token);
    return out;
  }

  async listCases(): Promise<CaseSummary[]> {
    const dirs = await this.listChildDirs(this.prefix);
    const out: CaseSummary[] = [];
    // Read each meta.json in parallel; skip dirs without one.
    const settled = await Promise.allSettled(
      dirs.map(async (caseId) => ({
        caseId,
        meta: await this.getJson<CaseMeta>(this.keyFor(caseId, 'meta.json')),
      }))
    );
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        out.push(r.value);
      }
    }
    out.sort((a, b) => a.caseId.localeCompare(b.caseId));
    return out;
  }

  readMeta(caseId: string): Promise<CaseMeta> {
    return this.getJson<CaseMeta>(this.keyFor(caseId, 'meta.json'));
  }

  async readMainAgent(caseId: string): Promise<MainAgentMessage[]> {
    return parseJsonl<MainAgentMessage>(
      await this.getText(this.keyFor(caseId, 'main_agent.jsonl'))
    );
  }

  async listFiringFiles(caseId: string, phase: FiringPhase): Promise<string[]> {
    const names = await this.listChildFiles(
      `${this.prefix}${caseId}/${phase}/`
    );
    return names.filter((n) => n.endsWith('.json')).sort();
  }

  readFiring(
    caseId: string,
    phase: FiringPhase,
    fileName: string
  ): Promise<FiringFile> {
    return this.getJson<FiringFile>(
      `${this.prefix}${caseId}/${phase}/${fileName}`
    );
  }

  readVerdicts(caseId: string): Promise<VerdictRow[]> {
    return this.getJsonlOrEmpty<VerdictRow>(
      this.keyFor(caseId, 'verdicts.jsonl')
    );
  }

  readTrajectory(caseId: string): Promise<TrajectoryRow[]> {
    return this.getJsonlOrEmpty<TrajectoryRow>(
      this.keyFor(caseId, 'trajectory.jsonl')
    );
  }

  async readSnapshot(
    caseId: string,
    sequence: number
  ): Promise<GraphSnapshotFile | null> {
    const padded = String(sequence).padStart(3, '0');
    try {
      return await this.getJson<GraphSnapshotFile>(
        `${this.prefix}${caseId}/event_graph/after_extractor_${padded}.json`
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  loadBundle(caseId: string): Promise<CaseBundle> {
    return loadBundleViaRepo(this, caseId);
  }

  async loadSftForCase(
    caseId: string,
    sessionId: string,
  ): Promise<CaseSftBundle | null> {
    // Per-case sibling first: `<prefix><caseId>/sft/*.jsonl`.
    const perCasePrefix = `${this.prefix}${caseId}/sft/`;
    const [pcExt, pcAud, pcDrop] = await Promise.all([
      this.getJsonlOrEmpty<SftRow>(`${perCasePrefix}extractor.jsonl`),
      this.getJsonlOrEmpty<SftRow>(`${perCasePrefix}auditor.jsonl`),
      this.getJsonlOrEmpty<DroppedRow>(`${perCasePrefix}dropped.jsonl`),
    ]);
    if (pcExt.length > 0 || pcAud.length > 0 || pcDrop.length > 0) {
      return { extractor: pcExt, auditor: pcAud, dropped: pcDrop };
    }

    // Fallback: global flat at `<prefix>sft/*.jsonl`, filtered by session.
    const globalPrefix = `${this.prefix}sft/`;
    const [gExt, gAud, gDrop] = await Promise.all([
      this.getJsonlOrEmpty<SftRow>(`${globalPrefix}extractor.jsonl`),
      this.getJsonlOrEmpty<SftRow>(`${globalPrefix}auditor.jsonl`),
      this.getJsonlOrEmpty<DroppedRow>(`${globalPrefix}dropped.jsonl`),
    ]);
    const extractor = gExt.filter((r) => r.session_id === sessionId);
    const auditor = gAud.filter((r) => r.session_id === sessionId);
    const dropped = gDrop.filter((r) => r.session_id === sessionId);
    if (extractor.length === 0 && auditor.length === 0 && dropped.length === 0) {
      return null;
    }
    return { extractor, auditor, dropped };
  }
}

export interface BlobProbeInfo {
  bucket: string;
  prefix: string;
  caseCount: number;
}

/** Probe a (bucket, prefix) by listing one page of common-prefixes. Used by
 *  the Settings page to confirm the path before saving. */
export async function probeBlobRoot(root: BlobRoot): Promise<BlobProbeInfo> {
  const page = await driverList(root.bucket, {
    prefix: root.prefix,
    delimiter: '/',
    max_keys: 1000,
  });
  const count = (page.common_prefixes ?? []).filter(
    (p) => p !== root.prefix
  ).length;
  return { bucket: root.bucket, prefix: root.prefix, caseCount: count };
}

/** Return a ready BlobCaseRepo when one has been configured, else null. */
export function probeBlobCaseRepo(): BlobCaseRepo | null {
  const root = getBlobRoot();
  if (!root) {
    return null;
  }
  return new BlobCaseRepo(root.bucket, root.prefix);
}

/**
 * Probe the configured backend (if any) and return a ready HttpCaseRepo.
 * Returns null when no URL is configured or the health check fails — the
 * caller falls back to the FS-Access flow.
 */
export async function probeHttpCaseRepo(): Promise<HttpCaseRepo | null> {
  const url = getBackendUrl();
  if (!url) {
    return null;
  }
  try {
    const info = await fetchHealth(url);
    return new HttpCaseRepo(url, info.root);
  } catch {
    return null;
  }
}
