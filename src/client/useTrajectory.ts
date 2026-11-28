import { useCallback, useEffect, useRef, useState } from 'react';
import type { IndexedPage, TrajectoryDelta, TrajectoryEvent } from '../model.ts';
import { errorMessage, queryUrl, request, sessionUrl } from './api.ts';

type Direction = 'before' | 'after' | 'around' | 'recent';
const HISTORY_BATCH = 250;

function mergeEvents(previous: TrajectoryEvent[], incoming: TrajectoryEvent[], removed: number[] = []) {
  if (incoming.length === 0 && removed.length === 0) return previous;
  const byOffset = new Map(previous.map(event => [event.source.offset, event]));
  for (const offset of removed) byOffset.delete(offset);
  for (const event of incoming) byOffset.set(event.source.offset, event);
  return [...byOffset.values()].sort((left, right) => left.source.offset - right.source.offset);
}

export function useTrajectory(id: string, active: boolean, loadAll: boolean) {
  const path = sessionUrl(id);
  const snapshot = useRef<IndexedPage | null>(null);
  const [page, setPage] = useState<IndexedPage | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [viewEpoch, setViewEpoch] = useState(0);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyFault, setHistoryFault] = useState<string | null>(null);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const fullMode = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const queue = useRef(Promise.resolve());

  const commit = useCallback((next: IndexedPage) => {
    if (snapshot.current?.generation && snapshot.current.generation !== next.generation) setViewEpoch(value => value + 1);
    snapshot.current = next;
    setPage(next);
  }, []);

  const run = useCallback((task: (signal: AbortSignal) => Promise<void>, interactive: boolean,
    reportError = setFault) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return Promise.resolve(false);
    if (interactive) setWorking(true);
    const scheduled = queue.current.then(async () => {
      if (signal.aborted) return false;
      try {
        await task(signal);
        if (!signal.aborted) setFault(null);
        return !signal.aborted;
      } catch (error) {
        if (!signal.aborted) reportError(errorMessage(error));
        return false;
      } finally {
        if (!signal.aborted && interactive) setWorking(false);
      }
    });
    queue.current = scheduled.then(() => undefined);
    return scheduled;
  }, []);

  // An inactive parent stays mounted so its scroll, filter and inspector selection survive.
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    lifetime.current = abort;
    queue.current = Promise.resolve();
    setWorking(false);
    let pending = false;
    const update = () => {
      if (pending) return;
      pending = true;
      void run(async signal => {
        if (!snapshot.current) {
          const first = await request<IndexedPage>(path, signal);
          if (!signal.aborted) commit(first);
          return;
        }
        let delta: TrajectoryDelta;
        do {
          const latest = snapshot.current;
          const endpoint = queryUrl(path + '/updates', {
            generation: latest.generation, revision: latest.revision,
            lower: latest.events[0]?.source.offset, upper: latest.later ? latest.events.at(-1)?.source.offset : undefined,
          });
          delta = await request<TrajectoryDelta>(endpoint, signal);
          if (signal.aborted) return;
          if (delta.reset) {
            const replacement = await request<IndexedPage>(path, signal);
            if (!signal.aborted) commit(replacement);
            return;
          }
          if (delta.revision !== latest.revision) {
            const events = mergeEvents(latest.events, delta.events, delta.removed);
            commit({ ...latest, revision: delta.revision, events });
          }
        } while (delta.more);
      }, false).finally(() => { pending = false; });
    };
    update();
    const timer = window.setInterval(update, 1500);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, [active, commit, path, run]);

  const loadPage = useCallback(async (direction: Direction, signal: AbortSignal, offset?: number, limit?: number) => {
    const current = snapshot.current;
    const cursor = direction === 'before' ? current?.events[0]?.source.offset
      : direction === 'after' ? current?.events.at(-1)?.source.offset : offset;
    const next = await request<IndexedPage>(direction === 'recent' ? path
      : queryUrl(path, { [direction]: cursor, generation: current?.generation, limit }), signal);
    if (signal.aborted) return;
    if (!current || current.generation !== next.generation || direction === 'around' || direction === 'recent') {
      commit(next);
      return;
    }
    commit({
      ...current, events: direction === 'before' ? [...next.events, ...current.events] : [...current.events, ...next.events],
      earlier: direction === 'before' ? next.earlier : current.earlier,
      later: direction === 'after' ? next.later : current.later,
    });
  }, [commit, path]);

  const fetchPage = useCallback((direction: Direction, offset?: number) =>
    run(signal => loadPage(direction, signal, offset), true), [loadPage, run]);

  const generation = page?.generation;
  const hasMoreHistory = Boolean(page?.earlier || page?.later);
  useEffect(() => {
    if (!active) return;
    const wasFull = fullMode.current;
    fullMode.current = loadAll;
    setHistoryFault(null);
    setLoadingHistory(false);
    if (!loadAll) {
      if (wasFull) void fetchPage('recent');
      return;
    }
    if (!generation || !hasMoreHistory) return;
    const abort = new AbortController();
    setLoadingHistory(true);
    const fillHistory = async () => {
      while (!abort.signal.aborted) {
        const current = snapshot.current;
        if (!current || current.generation !== generation || (!current.later && !current.earlier)) break;
        const loaded = await run(async signal => {
          const combined = AbortSignal.any([signal, abort.signal]);
          const latest = snapshot.current;
          if (combined.aborted || latest?.generation !== generation) return;
          if (latest.later) await loadPage('after', combined, undefined, HISTORY_BATCH);
          else if (latest.earlier) await loadPage('before', combined, undefined, HISTORY_BATCH);
        }, false, fault => { if (!abort.signal.aborted) setHistoryFault(fault); });
        if (!loaded) break;
      }
      if (!abort.signal.aborted) setLoadingHistory(false);
    };
    void fillHistory();
    return () => abort.abort();
  }, [active, fetchPage, generation, hasMoreHistory, historyAttempt, loadAll, loadPage, run]);

  return { page, fault, working, fetchPage, viewEpoch, loadingHistory, historyFault,
    retryHistory: () => setHistoryAttempt(value => value + 1) };
}
