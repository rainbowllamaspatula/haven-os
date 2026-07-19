/**
 * Shared room hooks — the patterns the Hearth, Listening Room and Post Box each
 * hand-rolled, extracted once so they can't drift apart again (per-key pending in
 * one room vs a whole-room lockout in another; colliding flash timers; a stale
 * read overwriting a fresh one). Every future room inherits these instead of
 * re-earning the bugs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ── useReadSequence ──────────────────────────────────────────────────────────
// A monotonic counter that makes a room's refresh safe against itself: begin()
// stamps a read, isCurrent() tells it whether a newer read has started since. A
// slow older read then bails instead of overwriting a newer one's fresh state
// ("flickers to a lie" — seen when a settle-read and a poll-read race). Shared by
// the poll and the settled action, so ALL reads honour the newest.
export function useReadSequence() {
  const seq = useRef(0);
  return useMemo(
    () => ({
      begin: () => ++seq.current,
      isCurrent: (s: number) => s === seq.current,
    }),
    [],
  );
}

// ── useVisiblePoll ───────────────────────────────────────────────────────────
// The load + interval + visibilitychange + cleanup pattern, plus two things the
// hand-rolled copies lacked: JITTER (so several rooms/tiles don't stampede the
// same tick) and ERROR BACKOFF (double the interval after consecutive failures,
// reset on success — a dead connection stops hammering). `fn` returns true on a
// good read, false on a failed one. Returns the poll's health for a stale ribbon.
const POLL_FAIL_BACKOFF_CAP = 4; // ×16 max
const STALE_FAIL_THRESHOLD = 2; // consecutive failures before "failing" is true

export function useVisiblePoll(
  fn: () => Promise<boolean>,
  baseMs: number,
  active: boolean,
): { lastSuccessAt: number | null; failing: boolean } {
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [failing, setFailing] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: number | undefined;
    let fails = 0;

    const schedule = () => {
      const interval = baseMs * 2 ** Math.min(fails, POLL_FAIL_BACKOFF_CAP);
      const withJitter = interval + interval * 0.15 * Math.random();
      timer = window.setTimeout(() => {
        if (document.visibilityState === 'visible') void run();
        else schedule(); // hidden: don't fetch, just keep the loop alive
      }, withJitter);
    };

    const run = async () => {
      if (cancelled) return;
      let ok = false;
      try {
        ok = await fnRef.current();
      } catch {
        ok = false;
      }
      if (cancelled) return;
      if (ok) {
        fails = 0;
        setLastSuccessAt(Date.now());
        setFailing(false);
      } else {
        fails += 1;
        setFailing(fails >= STALE_FAIL_THRESHOLD);
      }
      schedule();
    };

    void run(); // initial load
    const onVis = () => {
      if (document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [active, baseMs]);

  return { lastSuccessAt, failing };
}

// ── useSettledAction ─────────────────────────────────────────────────────────
// The honest-control pattern: mark a control pending, fire, then ALWAYS re-read
// so it shows the real resulting state — never an optimistic fake. Keyed, so one
// control settling never locks the whole room (the Listening Room's old
// whole-room lockout). Fixes the Hearth's colliding flash timers (ref-held, one
// per key) and gates the settle + trailing reads on `active` so a control acted
// on just before leaving the room can't fire a read into a hidden room.
//
// `run(key, fn)`: fn does the POST and throws on failure. On failure the control
// flashes "didn't take" (the caller reads `failed[key]`); either way the room's
// `refresh` runs after settleMs, then again after trailingMs (the slow-settle
// straggler catch). Re-entry for a key already in flight is dropped.
export function useSettledAction(opts: {
  settleMs: number;
  trailingMs: number;
  flashMs: number;
  active: boolean;
  refresh: () => Promise<unknown>;
  // Optional: the failure reason per key, for rooms that show it (the Listening
  // Room's NO_ACTIVE_DEVICE message) rather than a plain "didn't take".
  onError?: (key: string, err: unknown) => void;
}): {
  // gate (default true) drops a stacked commit for a key already in flight — right
  // for a dimmer/volume drag. Pass false to let a control queue (three quick Next
  // taps each fire); pending stays true until the last settles.
  run: (key: string, fn: () => Promise<void>, gate?: boolean) => Promise<void>;
  pending: Record<string, boolean>;
  failed: Record<string, boolean>;
} {
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  // Per-key in-flight COUNT (not a Set) so an ungated key can have several commits
  // running at once and pending clears only when the last one settles.
  const inFlight = useRef<Record<string, number>>({});
  const flashTimers = useRef<Record<string, number>>({});

  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  }, [opts]);

  const run = useCallback(async (key: string, fn: () => Promise<void>, gate = true) => {
    if (gate && (inFlight.current[key] ?? 0) > 0) return; // a commit for this control is already running
    inFlight.current[key] = (inFlight.current[key] ?? 0) + 1;
    setPending((p) => ({ ...p, [key]: true }));
    try {
      await fn();
    } catch (err) {
      console.error(`action ${key} failed:`, err);
      optsRef.current.onError?.(key, err);
      setFailed((f) => ({ ...f, [key]: true }));
      if (flashTimers.current[key]) clearTimeout(flashTimers.current[key]);
      flashTimers.current[key] = window.setTimeout(() => {
        setFailed((f) => {
          const { [key]: _drop, ...rest } = f;
          return rest;
        });
        delete flashTimers.current[key];
      }, optsRef.current.flashMs);
    } finally {
      await new Promise((r) => setTimeout(r, optsRef.current.settleMs));
      // Reads gated on active — never fetch into a room the user has left.
      if (optsRef.current.active) await optsRef.current.refresh();
      const trailing = optsRef.current.trailingMs;
      window.setTimeout(() => {
        if (optsRef.current.active) void optsRef.current.refresh();
      }, trailing);
      const n = (inFlight.current[key] ?? 1) - 1;
      if (n <= 0) {
        delete inFlight.current[key];
        setPending((p) => {
          const { [key]: _drop, ...rest } = p;
          return rest;
        });
      } else {
        inFlight.current[key] = n;
      }
    }
  }, []);

  return { run, pending, failed };
}

// ── agoLabel ─────────────────────────────────────────────────────────────────
// "updated Xm ago" for the stale-honesty ribbon. Shared so every room says it
// the same way.
export function agoLabel(ms: number): string {
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}
