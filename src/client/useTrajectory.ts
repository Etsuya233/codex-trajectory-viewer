import { useCallback, useEffect, useRef, useState } from 'react';
import type { IndexedPage, TrajectoryDelta, TrajectoryEvent } from '../model.ts';
import { errorMessage, queryUrl, request, sessionUrl } from './api.ts';

function mergeEvents(previous: TrajectoryEvent[], incoming: TrajectoryEvent[], removed: number[] = []) {
  if (incoming.length === 0 && removed.length === 0) return previous;
  const byOffset = new Map(previous.map(event => [event.source.offset, event]));
  for (const offset of removed) byOffset.delete(offset);
  for (const event of incoming) byOffset.set(event.source.offset, event);
  return [...byOffset.values()].sort((left, right) => left.source.offset - right.source.offset);
}

export function useTrajectory(id: string, active: boolean) {
  const path = sessionUrl(id);
  const snapshot = useRef<IndexedPage | null>(null);
  const [page, setPage] = useState<IndexedPage | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [viewEpoch, setViewEpoch] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  const queue = useRef(Promise.resolve());

  const commit = useCallback((next: IndexedPage) => {
    if (snapshot.current?.generation && snapshot.current.generation !== next.generation) setViewEpoch(value => value + 1);
    snapshot.current = next;
    setPage(next);
  }, []);

  const run = useCallback((task: (signal: AbortSignal) => Promise<void>, interactive: boolean) => {
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
        if (!signal.aborted) setFault(errorMessage(error));
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

  const fetchPage = useCallback((direction: 'before' | 'after' | 'around' | 'recent', offset?: number) => run(async signal => {
    const current = snapshot.current;
    const cursor = direction === 'before' ? current?.events[0]?.source.offset
      : direction === 'after' ? current?.events.at(-1)?.source.offset : offset;
    const next = await request<IndexedPage>(direction === 'recent' ? path
      : queryUrl(path, { [direction]: cursor, generation: current?.generation }), signal);
    if (signal.aborted) return;
    if (!current || current.generation !== next.generation || direction === 'around' || direction === 'recent') {
      commit(next);
      return;
    }
    commit({
      ...current, events: mergeEvents(current.events, next.events),
      earlier: direction === 'before' ? next.earlier : current.earlier,
      later: direction === 'after' ? next.later : current.later,
    });
  }, true), [commit, path, run]);

  return { page, fault, working, fetchPage, viewEpoch };
}
