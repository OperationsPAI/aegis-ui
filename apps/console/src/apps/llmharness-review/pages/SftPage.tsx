import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { FolderOpenOutlined } from '@ant-design/icons';
import {
  Button,
  Chip,
  DataTable,
  type DataTableColumn,
  EmptyState,
  ErrorState,
  type FilterChip,
  MetricLabel,
  MonoValue,
  Panel,
  PanelTitle,
  Toolbar,
} from '@lincyaw/aegis-ui';

import { SftRowDetail, SftStats } from '../components';
import {
  clearStoredSftRoot,
  isFsAccessSupported,
  pickSftRoot,
  probeBlobSftRepo,
  restoreSftRoot,
  type SftRepo,
} from '../repo';
import type { DroppedRow, SftRowBase } from '../schemas';

import './SftPage.css';

type Phase = 'extractor' | 'auditor';

interface LoadedSft {
  extractor: SftRowBase[];
  auditor: SftRowBase[];
  dropped: DroppedRow[];
}

function auditorSurfaced(row: SftRowBase): boolean {
  // TODO(sft-target-drift): reads the stale `target.tool_calls` shape; the
  // current SFT export emits `target.messages`. See SftRow in schemas.ts.
  const call = row.target.tool_calls[0];
  const v = (call?.arguments as { verdict?: { surface_reminder?: boolean } })
    ?.verdict;
  return Boolean(v?.surface_reminder);
}

type RepoSource = 'blob' | 'fs';

export function SftPage(): ReactElement {
  const [repo, setRepo] = useState<SftRepo | null>(null);
  const [repoSource, setRepoSource] = useState<RepoSource | null>(null);
  const [data, setData] = useState<LoadedSft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>('auditor');
  const [search, setSearch] = useState('');
  const [onlySurfaced, setOnlySurfaced] = useState(false);
  const [selected, setSelected] = useState<SftRowBase | null>(null);

  const refresh = useCallback(async (r: SftRepo) => {
    setLoading(true);
    setError(null);
    try {
      const [extractor, auditor, dropped] = await Promise.all([
        r.readExtractor(),
        r.readAuditor(),
        r.readDropped(),
      ]);
      setData({ extractor, auditor, dropped });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const blob = probeBlobSftRepo();
    if (blob) {
      setRepo(blob);
      setRepoSource('blob');
      void refresh(blob);
      return;
    }
    restoreSftRoot()
      .then((r) => {
        if (cancelled) return;
        if (r) {
          setRepo(r);
          setRepoSource('fs');
          void refresh(r);
        } else {
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const handlePick = useCallback(async () => {
    setError(null);
    try {
      const r = await pickSftRoot();
      setRepo(r);
      setRepoSource('fs');
      await refresh(r);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [refresh]);

  const handleClear = useCallback(async () => {
    if (repoSource === 'fs') {
      await clearStoredSftRoot();
    }
    setRepo(null);
    setRepoSource(null);
    setData(null);
    setSelected(null);
  }, [repoSource]);

  const rows: SftRowBase[] = useMemo(() => {
    if (!data) return [];
    return phase === 'extractor' ? data.extractor : data.auditor;
  }, [data, phase]);

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (phase === 'auditor' && onlySurfaced && !auditorSurfaced(r))
        return false;
      if (q) {
        const hay = [r.sample_id, r.session_id, String(r.turn_index)]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, phase, onlySurfaced]);

  if (!repo) {
    const fsSupported = isFsAccessSupported();
    return (
      <Panel
        title={<PanelTitle size='lg'>SFT preview</PanelTitle>}
        extra={<MetricLabel>llmharness · sft</MetricLabel>}
      >
        <EmptyState
          title='No SFT source configured'
          description={
            fsSupported
              ? 'Configure a Blob SFT source on the Connection page, or pick a local directory containing extractor.jsonl / auditor.jsonl / dropped.jsonl.'
              : 'Configure a Blob SFT source on the Connection page. (Local-directory picking is not available in this browser.)'
          }
          action={
            fsSupported ? (
              <Button onClick={handlePick}>
                <FolderOpenOutlined /> Open local directory
              </Button>
            ) : null
          }
        />
      </Panel>
    );
  }

  const columns: Array<DataTableColumn<SftRowBase>> = [
    {
      key: 'sample',
      header: 'sample_id',
      width: 260,
      render: (r) => (
        <button
          type='button'
          className='llmh-sft-row-pick'
          onClick={() => setSelected(r)}
        >
          <MonoValue size='sm'>{r.sample_id}</MonoValue>
        </button>
      ),
      truncate: true,
    },
    {
      key: 'session',
      header: 'session',
      width: 200,
      render: (r) => (
        <MonoValue size='sm'>{r.session_id.slice(0, 16)}</MonoValue>
      ),
    },
    {
      key: 'turn',
      header: 'turn',
      align: 'right',
      width: 80,
      render: (r) => <MonoValue size='sm'>{r.turn_index}</MonoValue>,
    },
    ...(phase === 'auditor'
      ? [
          {
            key: 'surfaced',
            header: 'verdict',
            width: 120,
            render: (r: SftRowBase) => {
              const surfaced = auditorSurfaced(r);
              return (
                <Chip tone={surfaced ? 'warning' : 'ghost'}>
                  {surfaced ? 'surfaced' : 'silent'}
                </Chip>
              );
            },
          },
        ]
      : []),
  ];

  const filterChips: FilterChip[] = [
    ...(phase === 'auditor' && onlySurfaced
      ? [{ key: 'surfaced', label: 'surfaced only' }]
      : []),
  ];

  return (
    <Panel
      title={<PanelTitle size='lg'>SFT preview</PanelTitle>}
      extra={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <MetricLabel>
            {repoSource === 'blob' ? `blob · ${repo.label}` : repo.label}
          </MetricLabel>
          <Button tone='ghost' onClick={() => void refresh(repo)}>
            Refresh
          </Button>
          <Button tone='ghost' onClick={() => void handleClear()}>
            {repoSource === 'blob' ? 'Detach' : 'Change root'}
          </Button>
        </div>
      }
    >
      {error && (
        <ErrorState title='Failed to read SFT root' description={error} />
      )}
      {data && (
        <>
          <SftStats
            extractor={data.extractor}
            auditor={data.auditor}
            dropped={data.dropped}
          />
          <Toolbar
            searchPlaceholder='sample_id / session / turn'
            searchValue={search}
            onSearchChange={setSearch}
            filters={filterChips}
            action={
              <div style={{ display: 'flex', gap: 8 }}>
                <Chip
                  tone={phase === 'extractor' ? 'ink' : 'default'}
                  onClick={() => {
                    setPhase('extractor');
                    setSelected(null);
                  }}
                >
                  extractor
                </Chip>
                <Chip
                  tone={phase === 'auditor' ? 'ink' : 'default'}
                  onClick={() => {
                    setPhase('auditor');
                    setSelected(null);
                  }}
                >
                  auditor
                </Chip>
                {phase === 'auditor' && (
                  <Chip
                    tone={onlySurfaced ? 'warning' : 'default'}
                    onClick={() => setOnlySurfaced((v) => !v)}
                  >
                    surfaced only
                  </Chip>
                )}
              </div>
            }
          />
          <div className='llmh-sft-grid'>
            <DataTable
              columns={columns}
              data={visibleRows}
              rowKey={(r) => `${r.session_id}#${r.turn_index}`}
              loading={loading}
              emptyTitle='No SFT rows'
              emptyDescription={
                rows.length === 0
                  ? `${phase}.jsonl is empty or missing.`
                  : 'Try clearing search / filter.'
              }
              persistKey={`llmharness.sft.${phase}`}
            />
            <div>
              {selected ? (
                <SftRowDetail row={selected} />
              ) : (
                <EmptyState
                  title='No row selected'
                  description='Click a row on the left to inspect its full input / target.'
                />
              )}
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}

export default SftPage;
