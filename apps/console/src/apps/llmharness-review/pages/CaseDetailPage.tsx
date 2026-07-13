import {
  createContext,
  type ReactElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useParams } from 'react-router-dom';
import { Modal } from 'antd';

import {
  Chip,
  EmptyState,
  ErrorState,
  MetricLabel,
  MonoValue,
  Panel,
  PanelTitle,
  ResizableSidePanel,
} from '@lincyaw/aegis-ui';

import {
  CaseMetaBar,
  EventGraphView,
  MessageBlocks,
  SftRowDetail,
} from '../components';
import {
  type CaseRepo,
  type CaseSftBundle,
  probeBlobCaseRepo,
  probeHttpCaseRepo,
  restoreCasesRoot,
} from '../repo';
import type {
  AuditorFiring,
  CaseBundle,
  ExtractorEvent,
  ExtractorFiring,
  Finding,
  MainTurn,
  SftRow,
} from '../schemas';
import { CaseSelectionProvider } from '../CaseSelection';
import { useCaseSelection } from '../selection';

import { FiringsTimeline } from './FiringsTimeline';

import './CaseDetailPage.css';

const EXCERPT_LIMIT = 80;

// --- Detail modal context ----------------------------------------------
//
// The right-rail DetailRail used to take ~360px of permanent screen real
// estate but only mattered when the user explicitly drilled into a node /
// turn / finding. We now open it on demand as a Modal: single-click still
// drives cross-pane highlight (same selection state), but a *double*
// click on a graph node, a turn row, or a firing chip pops the detail
// over the graph.

interface DetailModalApi {
  openDetail: () => void;
  openTurnsList: (turns: number[]) => void;
}

const DetailModalContext = createContext<DetailModalApi>({
  openDetail: () => undefined,
  openTurnsList: () => undefined,
});

function useDetailModal(): DetailModalApi {
  return useContext(DetailModalContext);
}

function firstTextExcerpt(turn: MainTurn): string {
  for (const block of turn.content) {
    if (
      block.type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      const text = (block as { text: string }).text.trim();
      if (text) {
        return text.length > EXCERPT_LIMIT
          ? `${text.slice(0, EXCERPT_LIMIT)}…`
          : text;
      }
    }
    if (block.type === 'tool_call') {
      const name = (block as { name?: unknown }).name;
      if (typeof name === 'string' && name) {
        return `→ ${name}`;
      }
    }
    if (block.type === 'tool_use') {
      const name = (block as { name?: unknown }).name;
      if (typeof name === 'string' && name) {
        return `→ ${name}`;
      }
    }
    if (block.type === 'tool_result') {
      const content = (block as { content?: unknown }).content;
      if (typeof content === 'string' && content.trim()) {
        const text = content.trim();
        return text.length > EXCERPT_LIMIT
          ? `${text.slice(0, EXCERPT_LIMIT)}…`
          : text;
      }
    }
    if (block.type === 'thinking') {
      const text = (block as { thinking?: unknown }).thinking;
      if (typeof text === 'string' && text.trim()) {
        return `(thinking)`;
      }
    }
  }
  return '';
}

// --- Turn rail (left) ---------------------------------------------------

interface TurnRailProps {
  bundle: CaseBundle;
}

function TurnRail({ bundle }: TurnRailProps): ReactElement {
  const { selection, set } = useCaseSelection();
  const { openDetail } = useDetailModal();
  const containerRef = useRef<HTMLDivElement>(null);

  const citedTurns = useMemo<Set<number>>(() => {
    if (selection.eventId === null) {
      return new Set();
    }
    for (const f of bundle.extractor) {
      const ev = f.output?.events.find((e) => e.id === selection.eventId);
      if (ev) {
        return new Set(ev.source_turns);
      }
    }
    return new Set();
  }, [selection.eventId, bundle.extractor]);

  const firingWindow = useMemo<Set<number>>(() => {
    if (selection.mode === 'extractor' && selection.extractorSeq !== null) {
      const f = bundle.extractor.find(
        (x) => x.sequence === selection.extractorSeq,
      );
      if (f) {
        return new Set(f.input.payload.new_turns.map((t) => t.index));
      }
    }
    if (selection.mode === 'auditor' && selection.auditorSeq !== null) {
      const f = bundle.auditor.find((x) => x.sequence === selection.auditorSeq);
      if (f) {
        return new Set([f.turn_index - 1]);
      }
    }
    return new Set();
  }, [
    selection.mode,
    selection.extractorSeq,
    selection.auditorSeq,
    bundle.extractor,
    bundle.auditor,
  ]);

  const reminderForTurn = useMemo<Map<number, number>>(() => {
    const m = new Map<number, number>();
    for (const [auditorSeq, turnIndex] of bundle.links.reminderInjection) {
      m.set(turnIndex, auditorSeq);
    }
    return m;
  }, [bundle.links.reminderInjection]);

  useEffect(() => {
    if (selection.turn === null) {
      return;
    }
    const el = containerRef.current?.querySelector(
      `[data-turn="${selection.turn.toString()}"]`,
    );
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selection.turn]);

  return (
    <div className='llmh-cdp__rail' ref={containerRef}>
      <header className='llmh-cdp__rail-head'>
        Main agent
        <MetricLabel size='xs'>{bundle.main.length}</MetricLabel>
      </header>
      <div className='llmh-cdp__rail-list'>
        {bundle.main.map((turn) => {
          const idx = turn.index;
          const selected = selection.turn === idx;
          const cited = citedTurns.has(idx);
          const inWindow = firingWindow.has(idx);
          const hasReminder = reminderForTurn.has(idx);
          const cls = [
            'llmh-cdp__rail-row',
            `llmh-cdp__rail-row--${turn.role}`,
            selected ? 'llmh-cdp__rail-row--selected' : '',
            cited ? 'llmh-cdp__rail-row--cited' : '',
            inWindow ? 'llmh-cdp__rail-row--window' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div
              key={idx}
              data-turn={idx}
              className={cls}
              role='button'
              tabIndex={0}
              onClick={() => {
                // Keep mode/extractorSeq/auditorSeq intact so the center
                // graph viewport stays on its current firing — single
                // click on a turn is just focus, not navigation.
                set({
                  turn: idx,
                  eventId: null,
                  findingId: null,
                });
              }}
              onDoubleClick={() => {
                set({
                  turn: idx,
                  eventId: null,
                  findingId: null,
                });
                openDetail();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  set({
                    turn: idx,
                    eventId: null,
                    findingId: null,
                  });
                }
              }}
            >
              <div className='llmh-cdp__rail-row-meta'>
                <MonoValue size='sm'>#{idx}</MonoValue>
                <span className='llmh-cdp__rail-row-role'>{turn.role}</span>
                {hasReminder && (
                  <span
                    className='llmh-cdp__rail-row-mark'
                    aria-label='reminder injected'
                  >
                    ●
                  </span>
                )}
              </div>
              <div className='llmh-cdp__rail-row-text'>
                {firstTextExcerpt(turn)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Graph viewport (center) -------------------------------------------

interface GraphViewportProps {
  bundle: CaseBundle;
}

function GraphViewport({ bundle }: GraphViewportProps): ReactElement {
  const { selection, set } = useCaseSelection();
  const { openDetail, openTurnsList } = useDetailModal();

  const orderedExtractors = useMemo<ExtractorFiring[]>(
    () => [...bundle.extractor].sort((a, b) => a.sequence - b.sequence),
    [bundle.extractor],
  );
  const orderedAuditors = useMemo<AuditorFiring[]>(
    () => [...bundle.auditor].sort((a, b) => a.sequence - b.sequence),
    [bundle.auditor],
  );

  const extractorFiring =
    selection.mode === 'extractor' && selection.extractorSeq !== null
      ? orderedExtractors.find((f) => f.sequence === selection.extractorSeq)
      : undefined;
  const auditorFiring =
    selection.mode === 'auditor' && selection.auditorSeq !== null
      ? orderedAuditors.find((f) => f.sequence === selection.auditorSeq)
      : undefined;

  const onSelectEvent = useCallback(
    (id: number) => {
      set({ eventId: id });
    },
    [set],
  );
  const onOpenEventDetail = useCallback(
    (id: number) => {
      set({ eventId: id });
      openDetail();
    },
    [set, openDetail],
  );

  if (extractorFiring) {
    const output = extractorFiring.output;
    const snapshot = bundle.graphs.get(extractorFiring.sequence);
    const outEvents = output?.events ?? [];
    const outEdges = output?.edges ?? [];
    const graphEvents = snapshot?.events ?? outEvents;
    const graphEdges = snapshot?.edges ?? outEdges;
    const newEventIds = snapshot
      ? new Set(outEvents.map((e) => e.id))
      : null;
    const droppedCount = output?.dropped_edges.length ?? 0;
    const idx = orderedExtractors.findIndex(
      (f) => f.sequence === extractorFiring.sequence,
    );
    const prev = idx > 0 ? orderedExtractors[idx - 1] : undefined;
    const next =
      idx >= 0 && idx < orderedExtractors.length - 1
        ? orderedExtractors[idx + 1]
        : undefined;
    return (
      <div className='llmh-cdp__viewport'>
        <header className='llmh-cdp__viewport-bar'>
          <MonoValue size='sm'>
            E#{extractorFiring.sequence} / {orderedExtractors.length}
          </MonoValue>
          <MetricLabel size='xs'>
            {graphEvents.length} events · {graphEdges.length} edges
            {snapshot ? ` · +${outEvents.length.toString()} new` : ''}
          </MetricLabel>
          <div className='llmh-cdp__viewport-spacer' />
          {prev && (
            <Chip
              tone='default'
              onClick={() => {
                set({ extractorSeq: prev.sequence, eventId: null });
              }}
            >
              ← E#{prev.sequence}
            </Chip>
          )}
          {next && (
            <Chip
              tone='default'
              onClick={() => {
                set({ extractorSeq: next.sequence, eventId: null });
              }}
            >
              E#{next.sequence} →
            </Chip>
          )}
          {droppedCount > 0 && (
            <Chip
              tone='warning'
              onClick={() => {
                const el = document.getElementById('llmh-insp__dropped');
                if (el) {
                  el.scrollIntoView({ block: 'start', behavior: 'smooth' });
                }
              }}
            >
              {droppedCount} dropped
            </Chip>
          )}
        </header>
        <div className='llmh-cdp__viewport-graph'>
          <EventGraphView
            events={graphEvents}
            edges={graphEdges}
            selectedEventId={selection.eventId}
            newEventIds={newEventIds}
            onSelectEvent={onSelectEvent}
            onOpenTurns={openTurnsList}
            onOpenDetail={onOpenEventDetail}
          />
        </div>
      </div>
    );
  }

  if (auditorFiring) {
    const snapshotRef = auditorFiring.input.graph_snapshot_ref;
    const snapshot = bundle.graphs.get(snapshotRef);
    const idx = orderedAuditors.findIndex(
      (f) => f.sequence === auditorFiring.sequence,
    );
    const prev = idx > 0 ? orderedAuditors[idx - 1] : undefined;
    const next =
      idx >= 0 && idx < orderedAuditors.length - 1
        ? orderedAuditors[idx + 1]
        : undefined;
    return (
      <div className='llmh-cdp__viewport'>
        <header className='llmh-cdp__viewport-bar'>
          <MonoValue size='sm'>
            A#{auditorFiring.sequence} / {orderedAuditors.length}
          </MonoValue>
          <MetricLabel size='xs'>
            {snapshot
              ? `${snapshot.events.length.toString()} events · ${snapshot.edges.length.toString()} edges (E#${snapshotRef.toString()})`
              : `snapshot E#${snapshotRef.toString()} missing`}
          </MetricLabel>
          <div className='llmh-cdp__viewport-spacer' />
          {prev && (
            <Chip
              tone='default'
              onClick={() => {
                set({ auditorSeq: prev.sequence, eventId: null });
              }}
            >
              ← A#{prev.sequence}
            </Chip>
          )}
          {next && (
            <Chip
              tone='default'
              onClick={() => {
                set({ auditorSeq: next.sequence, eventId: null });
              }}
            >
              A#{next.sequence} →
            </Chip>
          )}
        </header>
        <div className='llmh-cdp__viewport-graph'>
          {snapshot ? (
            <EventGraphView
              events={snapshot.events}
              edges={snapshot.edges}
              selectedEventId={selection.eventId}
              newEventIds={null}
              onSelectEvent={onSelectEvent}
              onOpenTurns={openTurnsList}
              onOpenDetail={onOpenEventDetail}
            />
          ) : (
            <EmptyState
              title='No graph snapshot'
              description={`bundle.graphs has no entry for E#${snapshotRef.toString()}`}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className='llmh-cdp__viewport'>
      <div className='llmh-cdp__viewport-graph'>
        <EmptyState
          title='Pick a firing'
          description='Click E#n or A#n in the timeline above to view its event graph.'
        />
      </div>
    </div>
  );
}

// --- Detail rail (right) ------------------------------------------------

interface DetailRailProps {
  bundle: CaseBundle;
}

function findEventById(
  bundle: CaseBundle,
  id: number,
): { event: ExtractorEvent; firing: ExtractorFiring } | null {
  for (const f of bundle.extractor) {
    const ev = f.output?.events.find((e) => e.id === id);
    if (ev) {
      return { event: ev, firing: f };
    }
  }
  for (const snap of bundle.graphs.values()) {
    const ev = snap.events.find((e) => e.id === id);
    if (ev) {
      const firing = bundle.extractor.find(
        (x) => x.sequence === snap.after_extractor_firing,
      );
      if (firing) {
        return { event: ev, firing };
      }
    }
  }
  return null;
}

function findingsCitingEvent(
  bundle: CaseBundle,
  eventId: number,
): Array<{ auditorSeq: number; finding: Finding }> {
  const out: Array<{ auditorSeq: number; finding: Finding }> = [];
  for (const a of bundle.auditor) {
    for (const f of a.input.findings) {
      if (f.related_event_ids.includes(eventId)) {
        out.push({ auditorSeq: a.sequence, finding: f });
      }
    }
  }
  return out;
}

function DetailRail({ bundle }: DetailRailProps): ReactElement {
  const { selection, set } = useCaseSelection();

  // --- Event detail
  if (selection.eventId !== null) {
    const hit = findEventById(bundle, selection.eventId);
    if (!hit) {
      return (
        <div className='llmh-insp'>
          <EmptyState
            title={`Event #${selection.eventId.toString()} not found`}
            description='This id is not present in any firing output or snapshot.'
          />
          <div className='llmh-insp__chip-row'>
            <Chip
              tone='ghost'
              onClick={() => {
                set({ eventId: null });
              }}
            >
              clear event
            </Chip>
          </div>
        </div>
      );
    }
    const { event, firing } = hit;
    const citing = findingsCitingEvent(bundle, event.id);
    const refs = (event.refs ?? []) as Array<{
      dst: number;
      kind: string;
      cited_quote?: string;
    }>;
    const externalRefs = (event as { external_refs?: unknown }).external_refs;
    return (
      <div className='llmh-insp'>
        <section className='llmh-insp__section'>
          <header className='llmh-insp__sec-head'>
            <span>event</span>
            <MetricLabel size='xs'>
              #{event.id} · origin E#{firing.sequence}
            </MetricLabel>
          </header>
          <div className='llmh-insp__chip-row'>
            <Chip tone='default'>{event.kind}</Chip>
          </div>
          <div className='llmh-cdp__detail-summary'>{event.summary}</div>
          {event.source_turns.length > 0 && (
            <div className='llmh-insp__chip-row'>
              <span>source_turns:</span>
              {event.source_turns.map((t) => (
                <Chip
                  key={t}
                  tone={selection.turn === t ? 'ink' : 'default'}
                  onClick={() => {
                    set({
                      turn: t,
                      mode: null,
                      extractorSeq: null,
                      auditorSeq: null,
                      eventId: null,
                      findingId: null,
                    });
                  }}
                >
                  #{t}
                </Chip>
              ))}
            </div>
          )}
        </section>

        {refs.length > 0 && (
          <section className='llmh-insp__section'>
            <header className='llmh-insp__sec-head'>
              <span>refs</span>
              <MetricLabel size='xs'>{refs.length}</MetricLabel>
            </header>
            {refs.map((r, i) => (
              <div key={i} className='llmh-cdp__detail-ref'>
                <div className='llmh-insp__chip-row'>
                  <MonoValue size='sm'>→ #{r.dst}</MonoValue>
                  <Chip tone='default'>{r.kind}</Chip>
                  <Chip
                    tone='ghost'
                    onClick={() => {
                      set({ eventId: r.dst });
                    }}
                  >
                    open
                  </Chip>
                </div>
                {r.cited_quote && (
                  <div className='llmh-insp__pre'>{r.cited_quote}</div>
                )}
              </div>
            ))}
          </section>
        )}

        {externalRefs !== undefined && (
          <details className='llmh-insp__details'>
            <summary>external_refs</summary>
            <pre className='llmh-insp__pre'>
              {JSON.stringify(externalRefs, null, 2)}
            </pre>
          </details>
        )}

        {citing.length > 0 && (
          <section className='llmh-insp__section'>
            <header className='llmh-insp__sec-head'>
              <span>cited by findings</span>
              <MetricLabel size='xs'>{citing.length}</MetricLabel>
            </header>
            <div className='llmh-insp__chip-row'>
              {citing.map((c) => (
                <Chip
                  key={`${c.auditorSeq.toString()}.${c.finding.index.toString()}`}
                  tone={
                    selection.findingId?.auditorSeq === c.auditorSeq &&
                    selection.findingId.index === c.finding.index
                      ? 'ink'
                      : 'default'
                  }
                  onClick={() => {
                    set({
                      findingId: {
                        auditorSeq: c.auditorSeq,
                        index: c.finding.index,
                      },
                    });
                  }}
                >
                  A#{c.auditorSeq} · F#{c.finding.index}
                </Chip>
              ))}
            </div>
          </section>
        )}

        <div className='llmh-insp__chip-row'>
          <Chip
            tone='ghost'
            onClick={() => {
              set({ eventId: null });
            }}
          >
            clear event
          </Chip>
        </div>
      </div>
    );
  }

  // --- Finding detail
  if (selection.findingId !== null) {
    const aud = bundle.auditor.find(
      (a) => a.sequence === selection.findingId?.auditorSeq,
    );
    const finding = aud?.input.findings.find(
      (f) => f.index === selection.findingId?.index,
    );
    if (!aud || !finding) {
      return (
        <div className='llmh-insp'>
          <EmptyState title='Finding not found' />
          <div className='llmh-insp__chip-row'>
            <Chip
              tone='ghost'
              onClick={() => {
                set({ findingId: null });
              }}
            >
              clear finding
            </Chip>
          </div>
        </div>
      );
    }
    return (
      <div className='llmh-insp'>
        <section className='llmh-insp__section'>
          <header className='llmh-insp__sec-head'>
            <span>finding</span>
            <MetricLabel size='xs'>
              A#{aud.sequence} · F#{finding.index}
            </MetricLabel>
          </header>
          <div className='llmh-insp__chip-row'>
            <Chip tone='default'>{finding.kind}</Chip>
          </div>
          <div className='llmh-cdp__detail-summary'>{finding.summary}</div>
          {finding.related_event_ids.length > 0 && (
            <div className='llmh-insp__chip-row'>
              <span>related events:</span>
              {finding.related_event_ids.map((id) => (
                <Chip
                  key={id}
                  tone={selection.eventId === id ? 'ink' : 'default'}
                  onClick={() => {
                    set({ eventId: id });
                  }}
                >
                  #{id}
                </Chip>
              ))}
            </div>
          )}
        </section>
        <div className='llmh-insp__chip-row'>
          <Chip
            tone='ghost'
            onClick={() => {
              set({ findingId: null });
            }}
          >
            clear finding
          </Chip>
        </div>
      </div>
    );
  }

  // --- Turn detail
  //
  // Turn must be checked BEFORE the firing-mode branch: the center graph
  // viewport stays alive even when the user picks a turn (single-click
  // on a row no longer clears mode/extractorSeq), so the firing inspector
  // would otherwise win and the modal would show firing meta instead of
  // the turn message the user just double-clicked.
  if (selection.turn !== null) {
    const turn = bundle.main.find((t) => t.index === selection.turn);
    if (!turn) {
      return (
        <div className='llmh-insp'>
          <EmptyState title={`Turn #${selection.turn.toString()} not found`} />
          <div className='llmh-insp__chip-row'>
            <Chip
              tone='ghost'
              onClick={() => {
                set({ turn: null });
              }}
            >
              clear turn
            </Chip>
          </div>
        </div>
      );
    }
    const ext = bundle.links.turnToExtractor.get(turn.index) ?? [];
    const aud = bundle.links.turnToAuditor.get(turn.index) ?? [];
    const turnIdx = bundle.main.findIndex((t) => t.index === turn.index);
    const prevTurn = turnIdx > 0 ? bundle.main[turnIdx - 1] : undefined;
    const nextTurn =
      turnIdx >= 0 && turnIdx < bundle.main.length - 1
        ? bundle.main[turnIdx + 1]
        : undefined;
    return (
      <div className='llmh-insp'>
        <div className='llmh-insp__sticky-head'>
          <div className='llmh-insp__sticky-title'>
            <MetricLabel size='xs'>turn</MetricLabel>
            <MonoValue size='sm'>#{turn.index}</MonoValue>
            <span className='llmh-cdp__rail-row-role'>{turn.role}</span>
            <MetricLabel size='xs'>
              {turnIdx + 1} / {bundle.main.length}
            </MetricLabel>
          </div>
          <div className='llmh-insp__sticky-nav'>
            <Chip
              tone='default'
              onClick={() => {
                if (prevTurn) {
                  set({
                    turn: prevTurn.index,
                    mode: null,
                    extractorSeq: null,
                    auditorSeq: null,
                    eventId: null,
                    findingId: null,
                  });
                }
              }}
            >
              ← {prevTurn ? `#${prevTurn.index.toString()}` : 'prev'}
            </Chip>
            <Chip
              tone='default'
              onClick={() => {
                if (nextTurn) {
                  set({
                    turn: nextTurn.index,
                    mode: null,
                    extractorSeq: null,
                    auditorSeq: null,
                    eventId: null,
                    findingId: null,
                  });
                }
              }}
            >
              {nextTurn ? `#${nextTurn.index.toString()}` : 'next'} →
            </Chip>
          </div>
        </div>
        <section className='llmh-insp__section'>
          <header className='llmh-insp__sec-head'>
            <span>turn</span>
            <MetricLabel size='xs'>
              #{turn.index} · {turn.role}
            </MetricLabel>
          </header>
          {(ext.length > 0 || aud.length > 0) && (
            <div className='llmh-insp__chip-row'>
              <span>cited by:</span>
              {ext.map((s) => (
                <Chip
                  key={`e${s.toString()}`}
                  tone={
                    selection.mode === 'extractor' &&
                    selection.extractorSeq === s
                      ? 'ink'
                      : 'default'
                  }
                  onClick={() => {
                    set({
                      mode: 'extractor',
                      extractorSeq: s,
                      auditorSeq: null,
                    });
                  }}
                >
                  E#{s}
                </Chip>
              ))}
              {aud.map((s) => (
                <Chip
                  key={`a${s.toString()}`}
                  tone={
                    selection.mode === 'auditor' && selection.auditorSeq === s
                      ? 'ink'
                      : 'default'
                  }
                  onClick={() => {
                    set({
                      mode: 'auditor',
                      auditorSeq: s,
                      extractorSeq: null,
                    });
                  }}
                >
                  A#{s}
                </Chip>
              ))}
            </div>
          )}
        </section>
        <section className='llmh-insp__section'>
          <MessageBlocks turn={turn} />
        </section>
        <div className='llmh-insp__chip-row'>
          <Chip
            tone='ghost'
            onClick={() => {
              set({ turn: null });
            }}
          >
            clear turn
          </Chip>
        </div>
      </div>
    );
  }

  return (
    <div className='llmh-insp'>
      <EmptyState
        title='Nothing selected'
        description='Pick a firing in the timeline above, or click a graph node / turn.'
      />
    </div>
  );
}

// --- SFT drawer ---------------------------------------------------------

type SftLoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; sft: CaseSftBundle }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

interface SftDrawerProps {
  repo: CaseRepo;
  caseId: string;
  sessionId: string;
}

function SftDrawer({
  repo,
  caseId,
  sessionId,
}: SftDrawerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'extractor' | 'auditor' | 'dropped'>(
    'extractor',
  );
  const [selected, setSelected] = useState<SftRow | null>(null);
  const [load, setLoad] = useState<SftLoadState>({ kind: 'idle' });

  useEffect(() => {
    if (!open || load.kind !== 'idle') {
      return undefined;
    }
    let cancelled = false;
    setLoad({ kind: 'loading' });
    repo
      .loadSftForCase(caseId, sessionId)
      .then((res) => {
        if (cancelled) {
          return;
        }
        if (!res) {
          setLoad({ kind: 'unavailable' });
        } else {
          setLoad({ kind: 'loaded', sft: res });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoad({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, load.kind, repo, caseId, sessionId]);

  const sft = load.kind === 'loaded' ? load.sft : null;

  const counts =
    sft !== null
      ? `${sft.extractor.length.toString()} ext · ${sft.auditor.length.toString()} aud · ${sft.dropped.length.toString()} dropped`
      : '—';

  const rows: SftRow[] = useMemo(() => {
    if (!sft) {
      return [];
    }
    if (tab === 'auditor') {
      return sft.auditor;
    }
    if (tab === 'extractor') {
      return sft.extractor;
    }
    return [];
  }, [sft, tab]);

  return (
    <div className='llmh-cdp__sft'>
      <button
        type='button'
        className='llmh-cdp__sft-head'
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <span>{open ? '▼' : '▶'} SFT export</span>
        <MetricLabel size='xs'>{counts}</MetricLabel>
      </button>
      {open && (
        <div className='llmh-cdp__sft-body'>
          {load.kind === 'loading' ? (
            <EmptyState title='Loading SFT…' />
          ) : load.kind === 'unavailable' ? (
            <EmptyState
              title='SFT not available'
              description='No sft/ directory or endpoint found for this case.'
            />
          ) : load.kind === 'error' ? (
            <ErrorState title='Failed to load SFT' description={load.message} />
          ) : !sft ? (
            <EmptyState title='SFT not available' />
          ) : (
            <>
              <div className='llmh-cdp__sft-tabs'>
                <Chip
                  tone={tab === 'extractor' ? 'ink' : 'default'}
                  onClick={() => {
                    setTab('extractor');
                    setSelected(null);
                  }}
                >
                  extractor ({sft.extractor.length})
                </Chip>
                <Chip
                  tone={tab === 'auditor' ? 'ink' : 'default'}
                  onClick={() => {
                    setTab('auditor');
                    setSelected(null);
                  }}
                >
                  auditor ({sft.auditor.length})
                </Chip>
                <Chip
                  tone={tab === 'dropped' ? 'ink' : 'default'}
                  onClick={() => {
                    setTab('dropped');
                    setSelected(null);
                  }}
                >
                  dropped ({sft.dropped.length})
                </Chip>
              </div>
              {tab === 'dropped' ? (
                <pre className='llmh-cdp__pre'>
                  {JSON.stringify(sft.dropped, null, 2)}
                </pre>
              ) : (
                <div className='llmh-cdp__sft-rows'>
                  <div className='llmh-cdp__sft-list'>
                    {rows.map((r) => (
                      <button
                        key={`${r.session_id}#${r.turn_index.toString()}#${r.sequence?.toString() ?? ''}`}
                        type='button'
                        className='llmh-cdp__sft-row-btn'
                        onClick={() => {
                          setSelected(r);
                        }}
                      >
                        turn {r.turn_index}
                        {r.sequence !== undefined && (
                          <MetricLabel size='xs'>
                            seq {r.sequence}
                          </MetricLabel>
                        )}
                      </button>
                    ))}
                  </div>
                  <div>
                    {selected ? (
                      <SftRowDetail row={selected} />
                    ) : (
                      <EmptyState title='Pick a row' />
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// --- Page root ----------------------------------------------------------

interface LoadedCase {
  repo: CaseRepo;
  caseId: string;
  bundle: CaseBundle;
}

function CaseDetailBody({ data }: { data: LoadedCase }): ReactElement {
  const { selection, set } = useCaseSelection();
  const [detailOpen, setDetailOpen] = useState(false);
  const [turnsList, setTurnsList] = useState<number[] | null>(null);

  // Default to the first extractor firing on first paint so the viewport
  // is never empty.
  useEffect(() => {
    if (selection.mode !== null) {
      return;
    }
    const first = data.bundle.extractor[0];
    if (first) {
      set({
        mode: 'extractor',
        extractorSeq: first.sequence,
      });
    } else {
      const firstAud = data.bundle.auditor[0];
      if (firstAud) {
        set({ mode: 'auditor', auditorSeq: firstAud.sequence });
      }
    }
    // We want this exactly once per case load. Deps would re-fire on
    // every selection change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.caseId]);

  const detailApi = useMemo<DetailModalApi>(
    () => ({
      openDetail: () => {
        setDetailOpen(true);
      },
      openTurnsList: (turns: number[]) => {
        setTurnsList(turns);
      },
    }),
    [],
  );

  const modalTitle = useMemo(() => {
    if (selection.eventId !== null) {
      return `Event #${selection.eventId.toString()}`;
    }
    if (selection.findingId !== null) {
      return `Finding A#${selection.findingId.auditorSeq.toString()} · F#${selection.findingId.index.toString()}`;
    }
    if (selection.turn !== null) {
      return `Turn #${selection.turn.toString()}`;
    }
    return 'Detail';
  }, [selection]);

  return (
    <DetailModalContext.Provider value={detailApi}>
      <div className='llmh-cdp'>
        <FiringsTimeline bundle={data.bundle} />
        <div className='llmh-cdp__layout'>
          <ResizableSidePanel
            side='left'
            defaultWidth={220}
            minWidth={160}
            maxWidth={480}
            collapsible
            persistKey='llmh-cdp-turn-w'
          >
            <TurnRail bundle={data.bundle} />
          </ResizableSidePanel>
          <GraphViewport bundle={data.bundle} />
        </div>
        <SftDrawer
          repo={data.repo}
          caseId={data.caseId}
          sessionId={data.bundle.meta.session_id}
        />
      </div>
      <Modal
        title={modalTitle}
        open={detailOpen}
        onCancel={() => {
          setDetailOpen(false);
        }}
        footer={null}
        width={720}
        destroyOnClose
        styles={{
          body: { maxHeight: '70vh', overflow: 'auto', padding: 0 },
        }}
      >
        <DetailRail bundle={data.bundle} />
      </Modal>
      <TurnsListModal
        open={turnsList !== null}
        turns={turnsList ?? []}
        bundle={data.bundle}
        onClose={() => {
          setTurnsList(null);
        }}
      />
    </DetailModalContext.Provider>
  );
}

interface TurnsListModalProps {
  open: boolean;
  turns: number[];
  bundle: CaseBundle;
  onClose: () => void;
}

function TurnsListModal({
  open,
  turns,
  bundle,
  onClose,
}: TurnsListModalProps): ReactElement {
  const resolved = useMemo(
    () =>
      turns
        .map((idx) => bundle.main.find((t) => t.index === idx))
        .filter((t): t is MainTurn => t !== undefined),
    [turns, bundle.main],
  );
  const title =
    turns.length === 1
      ? `Source turn #${turns[0].toString()}`
      : `Source turns (${turns.length.toString()})`;
  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      destroyOnClose
      styles={{
        body: { maxHeight: '70vh', overflow: 'auto', padding: 0 },
      }}
    >
      <div className='llmh-cdp__turns-list'>
        {resolved.length === 0 ? (
          <EmptyState
            title='No turns to show'
            description='The cited source_turns are not present in main_agent.jsonl.'
          />
        ) : (
          resolved.map((turn) => (
            <section key={turn.index} className='llmh-cdp__turns-list-item'>
              <header className='llmh-cdp__turns-list-head'>
                <MetricLabel size='xs'>turn</MetricLabel>
                <MonoValue size='sm'>#{turn.index}</MonoValue>
                <span className='llmh-cdp__rail-row-role'>{turn.role}</span>
              </header>
              <MessageBlocks turn={turn} />
            </section>
          ))
        )}
      </div>
    </Modal>
  );
}

export function CaseDetailPage(): ReactElement {
  const params = useParams<{ caseId: string }>();
  const caseId = params.caseId ? decodeURIComponent(params.caseId) : '';

  const [data, setData] = useState<LoadedCase | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setData(null);
    (async (): Promise<CaseRepo | null> => {
      const http = await probeHttpCaseRepo();
      if (http) {
        return http;
      }
      const blob = probeBlobCaseRepo();
      if (blob) {
        return blob;
      }
      return restoreCasesRoot();
    })()
      .then(async (repo) => {
        if (cancelled) {
          return;
        }
        if (!repo) {
          setError(
            'No backend connected. Configure a `llmharness serve` URL, a blob root (bucket + prefix), or open a local cases root from the Cases list first.',
          );
          return;
        }
        const bundle = await repo.loadBundle(caseId);
        if (cancelled) {
          return;
        }
        setData({ repo, caseId, bundle });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  const header = (
    <PanelTitle size='lg'>
      <Link to='..' style={{ color: 'inherit', textDecoration: 'none' }}>
        ← Cases
      </Link>
    </PanelTitle>
  );

  if (error) {
    return (
      <Panel title={header}>
        <ErrorState title='Failed to load case' description={error} />
      </Panel>
    );
  }
  if (!data) {
    return (
      <Panel title={header}>
        <EmptyState title='Loading…' />
      </Panel>
    );
  }

  return (
    <Panel title={header} extra={<CaseMetaBar meta={data.bundle.meta} />}>
      <CaseSelectionProvider links={data.bundle.links}>
        <CaseDetailBody data={data} />
      </CaseSelectionProvider>
    </Panel>
  );
}

export default CaseDetailPage;
