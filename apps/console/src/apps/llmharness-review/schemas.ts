/**
 * Type contracts and link-graph derivation for a llmharness case directory.
 *
 * Layered shape:
 *   - On-disk leaf shapes (CaseMeta, MainTurn, ExtractorFiring, AuditorFiring,
 *     GraphSnapshot, SftRow, DroppedRow).
 *   - CaseBundle aggregates everything one case ever needs in memory.
 *   - CaseLinks indexes the three ID spaces (main.index,
 *     extractor-firing-local event id, aggregator-renumbered global event id)
 *     so panes never recompute their own cross-references.
 */

export interface CaseMeta {
  case_id: string;
  /** OTel span_id of the main-agent session-root span; the
   *  `.agentm/observability/<session_id>.jsonl` filename. */
  session_id: string;
  /** OTel trace_id shared across the whole agent tree (main + spawned
   *  extractor/auditor children). Empty for offline-synthesised cases. */
  trace_id: string;
  sample_id: string | null;
  dataset_name: string | null;
  dataset_path: string | null;
  started_at_ns: number;
  ended_at_ns: number;
  extractor_firings: number;
  auditor_firings: number;
  surfaced_reminders: number;
  silent_verdicts: number;
}

export type FiringStatus =
  | 'ok'
  | 'no_call'
  | 'spawn_error'
  | 'prompt_error'
  | 'partial';
export type FiringPhase = 'extractor' | 'auditor';

/**
 * On-the-wire shapes for a main-agent turn's content blocks. The
 * aggregator emits AgentM-native (tool_call / tool_result with
 * tool_call_id, nested content arrays). Anthropic-SDK shapes (tool_use
 * + tool_use_id) and LangGraph-state shapes (string content) are also
 * accepted by `messageAdapter.normalizeTurn` so callers never see raw
 * JSON in the chat column.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      tool_call_id?: string;
      tool_use_id?: string;
      content: unknown;
      is_error?: boolean;
    }
  | { type: 'thinking'; thinking: string }
  | { type: string; [k: string]: unknown };

export interface MainTurn {
  index: number;
  role: 'user' | 'assistant' | 'system' | 'tool' | string;
  content: ContentBlock[];
  [k: string]: unknown;
}

export interface ExtractorEvent {
  id: number;
  kind: string;
  summary: string;
  source_turns: number[];
  refs?: Array<{ dst: number; kind: string; cited_quote?: string }>;
  [k: string]: unknown;
}

export interface GraphEdge {
  src: number;
  dst: number;
  kind: string;
  reason?: string;
  cited_entities?: string[];
  [k: string]: unknown;
}

export interface ExtractorFiring {
  phase: 'extractor';
  sequence: number;
  turn_index: number;
  ts_ns: number;
  status: FiringStatus;
  error: string | null;
  latency_ms: number;
  input: {
    payload: {
      new_turns: MainTurn[];
      summary_threshold: number;
      recent_graph?: Array<Pick<ExtractorEvent, 'id' | 'kind' | 'summary'>>;
      case_brief?: string;
      [k: string]: unknown;
    };
  };
  output: {
    events: ExtractorEvent[];
    edges: GraphEdge[];
    dropped_edges: Array<{ reason: string; raw?: unknown }>;
  } | null;
}

export interface Finding {
  index: number;
  kind: string;
  summary: string;
  related_event_ids: number[];
  [k: string]: unknown;
}

export interface AuditorFiring {
  phase: 'auditor';
  sequence: number;
  turn_index: number;
  ts_ns: number;
  status: FiringStatus;
  error: string | null;
  latency_ms: number;
  input: {
    graph_snapshot_ref: number;
    findings: Finding[];
    continuation_notes: string[];
    check_errors: Record<string, string>;
    tools_profile: string;
    trajectory_snapshot_len: number;
    [k: string]: unknown;
  };
  output: {
    surface_reminder: boolean;
    reminder_text?: string;
    matched_event_ids?: number[];
    continuation_notes?: string[];
    cited_cards?: unknown[];
    drill_down?: Array<{ call: string; args: unknown; result: unknown }>;
    [k: string]: unknown;
  } | null;
}

export interface GraphSnapshot {
  after_extractor_firing: number;
  turn_index: number;
  events: ExtractorEvent[];
  edges: GraphEdge[];
}

export interface SftToolCall {
  name: string;
  arguments: unknown;
}

export interface SftRow {
  phase: FiringPhase;
  sample_id: string;
  session_id: string;
  turn_index: number;
  sequence?: number;
  input: { system: string; user: string };
  // TODO(sft-target-drift): the v19 extractor refactor changed the SFT
  // export shape to `target: { messages: AssistantMessage[] }` (multi-turn
  // trajectory, one assistant message per tool_call with a <think> block).
  // This `{ tool_calls }` shape is stale — only `distill export` writes
  // sft/*.jsonl (NOT `aggregate replay`), so the case-viewer path is
  // unaffected. Align this + SftPage rendering in a follow-up pass.
  target: { tool_calls: SftToolCall[] };
  meta?: Record<string, unknown>;
}

export interface DroppedRow {
  sample_id?: string;
  session_id?: string;
  turn_index?: number;
  drop_reason?: string;
  [k: string]: unknown;
}

export interface VerdictRow {
  sequence: number;
  turn_index: number;
  ts_ns: number;
  surface_reminder: boolean;
  reminder_text?: string;
  matched_event_ids?: number[];
  continuation_notes?: string[];
  cited_cards?: unknown[];
  [k: string]: unknown;
}

export interface TrajectoryRow {
  ts_ns: number;
  source: FiringPhase;
  sequence: number;
  turn_index: number;
  summary: string;
  ref: string;
}

export interface CaseSummary {
  caseId: string;
  meta: CaseMeta;
}

export interface CaseLinks {
  turnToExtractor: Map<number, number[]>;
  turnToAuditor: Map<number, number[]>;
  eventOrigin: Map<number, number>;
  eventToAuditor: Map<number, number[]>;
  reminderInjection: Map<number, number>;
}

export interface CaseBundle {
  meta: CaseMeta;
  main: MainTurn[];
  extractor: ExtractorFiring[];
  auditor: AuditorFiring[];
  graphs: Map<number, GraphSnapshot>;
  sft?: { extractor: SftRow[]; auditor: SftRow[]; dropped: DroppedRow[] };
  links: CaseLinks;
}

function pushToMap<K, V>(m: Map<K, V[]>, key: K, value: V): void {
  const cur = m.get(key);
  if (cur) {
    cur.push(value);
  } else {
    m.set(key, [value]);
  }
}

function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function turnText(turn: MainTurn): string {
  const parts: string[] = [];
  for (const block of turn.content) {
    if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      parts.push((block as { text: string }).text);
    } else if (
      block.type === 'tool_result' &&
      typeof (block as { content?: unknown }).content === 'string'
    ) {
      parts.push((block as { content: string }).content);
    }
  }
  return parts.join(' ');
}

export function computeCaseLinks(
  bundle: Omit<CaseBundle, 'links'>,
): CaseLinks {
  const turnToExtractor = new Map<number, number[]>();
  const turnToAuditor = new Map<number, number[]>();
  const eventOrigin = new Map<number, number>();
  const eventToAuditor = new Map<number, number[]>();
  const reminderInjection = new Map<number, number>();

  // `firing.turn_index` is 1-based; `main_agent[k].index` is 0-based.
  // Key by main index for direct lookup from the main column.
  for (const f of bundle.extractor) {
    pushToMap(turnToExtractor, f.turn_index - 1, f.sequence);
  }
  for (const f of bundle.auditor) {
    pushToMap(turnToAuditor, f.turn_index - 1, f.sequence);
  }

  for (const [seq, snap] of bundle.graphs) {
    for (const ev of snap.events) {
      if (!eventOrigin.has(ev.id)) {
        eventOrigin.set(ev.id, seq);
      }
    }
  }
  for (const f of bundle.extractor) {
    if (!f.output) {
      continue;
    }
    for (const ev of f.output.events) {
      if (!eventOrigin.has(ev.id)) {
        eventOrigin.set(ev.id, f.sequence);
      }
    }
  }

  for (const a of bundle.auditor) {
    const ids = new Set<number>();
    for (const finding of a.input.findings) {
      for (const id of finding.related_event_ids) {
        ids.add(id);
      }
    }
    for (const id of a.output?.matched_event_ids ?? []) {
      ids.add(id);
    }
    for (const id of ids) {
      pushToMap(eventToAuditor, id, a.sequence);
    }
  }

  for (const a of bundle.auditor) {
    if (!a.output?.surface_reminder) {
      continue;
    }
    const needle = a.output.reminder_text;
    if (!needle) {
      continue;
    }
    const n = normalizeForMatch(needle);
    if (!n) {
      continue;
    }
    for (const turn of bundle.main) {
      if (turn.index < a.turn_index) {
        continue;
      }
      const hay = normalizeForMatch(turnText(turn));
      if (hay.includes(n)) {
        reminderInjection.set(a.sequence, turn.index);
        break;
      }
    }
  }

  return {
    turnToExtractor,
    turnToAuditor,
    eventOrigin,
    eventToAuditor,
    reminderInjection,
  };
}

// --- Back-compat aliases for code that still imports from './types'. -------
// The old `types.ts` file is removed; consumers should migrate to these names.

export type MainAgentMessage = MainTurn;
export type FiringFile = ExtractorFiring | AuditorFiring;
export type GraphEvent = ExtractorEvent;
export type GraphSnapshotFile = GraphSnapshot;
export type SftRowBase = SftRow;
export type EventKind = string;
export type EdgeKind = string;
