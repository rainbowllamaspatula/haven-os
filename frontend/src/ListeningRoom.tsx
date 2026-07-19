/**
 * The Listening Room — the music room.
 *
 * A visual player + browse over the NATIVE Spotify hands (spotify.ts — Spec
 * §7's "Spotify MCP" line is stale; this room is native, per the 4 Jul brief).
 * The hero is a centred, capped album-art square so the transport sits above
 * the fold — Elle's ruling: thumb straight to play, no scrolling. Browse
 * (Recent / Playlists / Search) scrolls below. The listening journal is a
 * visible, inert "soon" strip — it wires up when reflections are real.
 *
 * Disciplines carried from today's Hearth build:
 *  - honest pending on every control; a failure flashes the real reason
 *    (NO_ACTIVE_DEVICE's message matters here) and the next read shows truth;
 *  - controls settle briefly before the truth-read, with a trailing read;
 *  - volume slider fires on release, label tracks the drag;
 *  - poll only while the room is active; last-good on a failed refresh.
 *
 * Progress ticks CLIENT-SIDE: the player state is polled gently (~8s) and the
 * bar interpolates from the payload's `at` timestamp between polls — smooth
 * without hammering Spotify.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useVisiblePoll, useSettledAction, useReadSequence, agoLabel as staleAgo } from './hooks';

// Mirrors backend/src/spotify.ts NowPlaying.
type NowPlaying = {
  playing: boolean;
  track: string | null;
  artist: string | null;
  album: string | null;
  art: string | null;
  art_large: string | null;
  progress_ms: number | null;
  duration_ms: number | null;
  shuffle: boolean;
  repeat: 'off' | 'context' | 'track';
  volume: number | null;
  device: string | null;
  at: number;
};
type RecentRow = { track: string; artist: string; uri: string; art: string | null; played_at: string };
type PlaylistRow = { name: string; uri: string; tracks: number | null; owner: string | null; art: string | null };

// The account holder's own playlists read "you", not their display name. The
// name comes back with the playlists payload (the listening.owner_display
// config row — WAS a hardcoded constant, Haven fork).
type SearchRow = { title: string; sub: string; uri: string; art: string | null; kind: string };

type Tab = 'recent' | 'playlists' | 'search';

const POLL_MS = 8_000;
const SETTLE_MS = 800;
const FAILED_FLASH_MS = 3_000;
// Past this since the last good read (or 2 failed polls), the stale ribbon owns up.
const STALE_MS = 60_000;

// Keys that move a range input — the only ones that commit the volume on keyUp
// (so Tab in/out of the slider doesn't fire a redundant Spotify call).
const RANGE_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown',
]);

// Fallback art gradients (mockup's g1–g6) for rows/hero with no image.
const GRADS = ['lr-g1', 'lr-g2', 'lr-g3', 'lr-g4', 'lr-g5', 'lr-g6'];
const gradFor = (s: string) =>
  GRADS[[...s].reduce((a, c) => (a + c.charCodeAt(0)) % GRADS.length, 0)];

function fmtMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '–:––';
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// "2h ago" for the Recent rows — same convention as the other rooms.
function agoLabel(iso: string, now: number): string {
  if (!iso) return '';
  const sec = Math.round((now - new Date(iso).getTime()) / 1000);
  if (sec < 90) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return day === 1 ? 'yesterday' : `${day}d ago`;
}

export function ListeningRoom({ active }: { active: boolean }) {
  // Last-good player state; null until the first read lands.
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // Interpolated progress for the bar — ticks locally between polls.
  const [shownProgress, setShownProgress] = useState<number | null>(null);

  const [tab, setTab] = useState<Tab>('recent');
  const [recent, setRecent] = useState<RecentRow[] | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistRow[] | null>(null);
  // The account's display name, for the "you" collapse. null = never collapse.
  const [ownerDisplay, setOwnerDisplay] = useState<string | null>(null);
  // Per-tab browse errors — one failing list shouldn't blank the other.
  const [recentFailed, setRecentFailed] = useState(false);
  const [playlistsFailed, setPlaylistsFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchRow[] | null>(null);
  const [searchFailed, setSearchFailed] = useState(false);

  // The failure REASON (NO_ACTIVE_DEVICE etc.) — the Listening Room shows it, set
  // via useSettledAction's onError and cleared on a timer.
  const [failMsg, setFailMsg] = useState<string | null>(null);
  const failTimer = useRef<number | null>(null);

  // Volume drag draft — slider fires on release (the Hearth ruling).
  const [volDraft, setVolDraft] = useState<number | null>(null);

  // Sequence-safe player read — a slow older read bails rather than overwriting a
  // newer one. Returns whether it landed (drives the ribbon).
  const readSeq = useReadSequence();
  const refreshPlayer = useCallback(async (): Promise<boolean> => {
    const s = readSeq.begin();
    try {
      const res = await api(`/spotify/now-playing`);
      const data = await res.json();
      if (!readSeq.isCurrent(s)) return true; // superseded by a newer read
      if (data.ok && data.nowPlaying) {
        setNp(data.nowPlaying);
        setLoadFailed(false);
        return true;
      }
      setLoadFailed(true);
      return false;
    } catch (err) {
      console.error('Failed to load player state:', err);
      if (readSeq.isCurrent(s)) setLoadFailed(true);
      return false;
    }
  }, [readSeq]);

  const loadBrowse = useCallback(async () => {
    // Settled — a failing recent list shouldn't blank playlists (or vice versa).
    const [r, p] = await Promise.allSettled([
      api(`/spotify/recent`).then((x) => x.json()),
      api(`/spotify/playlists`).then((x) => x.json()),
    ]);
    if (r.status === 'fulfilled' && r.value.ok && Array.isArray(r.value.tracks)) {
      setRecent(r.value.tracks);
      setRecentFailed(false);
    } else setRecentFailed(true);
    if (p.status === 'fulfilled' && p.value.ok && Array.isArray(p.value.playlists)) {
      setPlaylists(p.value.playlists);
      if (typeof p.value.owner_display === 'string') setOwnerDisplay(p.value.owner_display);
      setPlaylistsFailed(false);
    } else setPlaylistsFailed(true);
  }, []);

  // Player poll (jitter + backoff); its health drives the stale ribbon and freezes
  // the progress bar when the connection's dead.
  const { lastSuccessAt, failing } = useVisiblePoll(refreshPlayer, POLL_MS, active);

  // Browse loads on entry + foreground (no interval — it changes slowly).
  useEffect(() => {
    if (!active) return;
    void loadBrowse();
    const onVis = () => {
      if (document.visibilityState === 'visible') void loadBrowse();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [active, loadBrowse]);

  // The local progress tick: interpolate from the payload's read-time — but freeze
  // at the last-read position when the connection's stale (a dead connection must
  // not show a moving bar).
  useEffect(() => {
    if (!active || !np || np.progress_ms === null) {
      setShownProgress(np?.progress_ms ?? null);
      return;
    }
    const tick = () => {
      const raw = np.playing && !failing ? np.progress_ms! + (Date.now() - np.at) : np.progress_ms!;
      setShownProgress(np.duration_ms !== null ? Math.min(raw, np.duration_ms) : raw);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [active, np, failing]);

  // Debounced search while its tab is open.
  useEffect(() => {
    if (!active || tab !== 'search') return;
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearchFailed(false);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api(`/spotify/search?q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((data) => {
          if (cancelled) return;
          if (data.ok && Array.isArray(data.results)) {
            setResults(data.results);
            setSearchFailed(false);
          } else setSearchFailed(true);
        })
        .catch(() => {
          if (!cancelled) setSearchFailed(true);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [active, tab, query]);

  // Honest per-control pending + settle/trailing truth-read. Keyed so one control
  // never locks the room; the failure REASON goes to failMsg via onError.
  const { run, pending } = useSettledAction({
    settleMs: SETTLE_MS,
    trailingMs: 2_000,
    flashMs: FAILED_FLASH_MS,
    active,
    refresh: refreshPlayer,
    onError: (_key, err) => {
      const msg = err instanceof Error ? err.message : 'failed';
      setFailMsg(msg);
      if (failTimer.current) clearTimeout(failTimer.current);
      failTimer.current = window.setTimeout(() => setFailMsg(null), FAILED_FLASH_MS);
    },
  });

  // A transport action, keyed. gate=false lets a control queue (three quick Next
  // taps each fire); the volume drag keeps gate=true (drop-stacked, like the dimmer).
  const act = useCallback(
    (key: string, body: Record<string, unknown>, gate = true) =>
      run(
        key,
        async () => {
          const res = await api(`/spotify/player`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error ?? 'failed');
        },
        gate,
      ).finally(() => setVolDraft(null)),
    [run],
  );

  // Any control in flight → the hero pulses.
  const anyPending = Object.values(pending).some(Boolean);

  function seekFromBar(e: React.MouseEvent<HTMLDivElement>) {
    if (!np || np.duration_ms === null || pending['seek']) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    void act('seek', { action: 'seek', position_ms: Math.round(ratio * np.duration_ms) });
  }

  const hasTrack = np !== null && np.track !== null;
  const noDevice = np !== null && np.device === null && !hasTrack;
  const nextRepeat = np?.repeat === 'off' ? 'context' : np?.repeat === 'context' ? 'track' : 'off';
  const shownVol = volDraft ?? np?.volume ?? 0;

  function browseRow(
    key: string,
    art: string | null,
    gradSeed: string,
    icon: string,
    title: string,
    sub: string,
    meta: string,
    uri: string,
  ) {
    return (
      <button key={key} className="lr-row" disabled={!!pending[`play:${uri}`]} onClick={() => void act(`play:${uri}`, { action: 'play', uri })}>
        {art ? (
          <img className="lr-row__art" src={art} alt="" loading="lazy" />
        ) : (
          <span className={`lr-row__art ${gradFor(gradSeed)}`}>
            <i className={`ti ${icon}`} aria-hidden="true" />
          </span>
        )}
        <span className="lr-row__body">
          <span className="lr-row__title">{title}</span>
          {sub && <span className="lr-row__sub">{sub}</span>}
        </span>
        {meta && <span className="lr-row__meta">{meta}</span>}
        <span className="lr-row__play">
          <i className="ti ti-player-play" aria-hidden="true" />
        </span>
      </button>
    );
  }

  return (
    <div className="lroom">
      {/* Stale honesty — a quiet ribbon when the player read isn't live. */}
      {lastSuccessAt !== null && (failing || Date.now() - lastSuccessAt > STALE_MS) && (
        <div className="room-stale">
          <i className="ti ti-cloud-off" aria-hidden="true" /> updated {staleAgo(lastSuccessAt)}
        </div>
      )}
      {/* ── Now-playing hero ── */}
      <div className={`lr-np ${anyPending ? 'lr-busy' : ''}`}>
        {np?.art_large ? (
          <img className="lr-np__art" src={np.art_large} alt={np.album ?? 'album art'} />
        ) : (
          <div className={`lr-np__art lr-np__art--empty ${hasTrack ? gradFor(np?.track ?? '') : 'lr-g2'}`}>
            <i className={`ti ${noDevice ? 'ti-device-speaker-off' : 'ti-music'}`} aria-hidden="true" />
          </div>
        )}
        <div className="lr-np__meta">
          {np === null ? (
            <div className="lr-np__track">{loadFailed ? "Couldn't reach Spotify" : 'Listening…'}</div>
          ) : hasTrack ? (
            <>
              <div className="lr-np__track">{np.track}</div>
              <div className="lr-np__artist">{np.artist ?? ''}</div>
              <div className="lr-np__album">
                {np.album ?? ''}
                {np.device ? ` · on ${np.device}` : ''}
              </div>
            </>
          ) : (
            <>
              <div className="lr-np__track">Nothing playing</div>
              <div className="lr-np__artist">
                Open Spotify on a device — the room wakes with it.
              </div>
            </>
          )}
        </div>

        <div className="lr-np__progress">
          <span className="lr-np__time">{fmtMs(shownProgress)}</span>
          <div
            className="lr-np__bar"
            role={np?.duration_ms != null ? 'slider' : undefined}
            aria-label="Seek"
            onClick={seekFromBar}
          >
            <div
              className="lr-np__fill"
              style={{
                width:
                  np?.duration_ms && shownProgress !== null
                    ? `${Math.min(100, (shownProgress / np.duration_ms) * 100)}%`
                    : '0%',
              }}
            />
          </div>
          <span className="lr-np__time lr-np__time--r">{fmtMs(np?.duration_ms ?? null)}</span>
        </div>

        <div className="lr-np__transport">
          <button
            className={`lr-tbtn lr-tbtn--sm ${np?.shuffle ? 'lr-tbtn--on' : ''}`}
            aria-label={`Shuffle ${np?.shuffle ? 'off' : 'on'}`}
            disabled={!!pending['shuffle'] || !hasTrack}
            onClick={() => void act('shuffle', { action: 'shuffle', on: !np?.shuffle })}
          >
            <i className="ti ti-arrows-shuffle" aria-hidden="true" />
          </button>
          <button
            className="lr-tbtn"
            aria-label="Previous track"
            disabled={!hasTrack}
            onClick={() => void act('prev', { action: 'previous' }, false)}
          >
            <i className="ti ti-player-skip-back" aria-hidden="true" />
          </button>
          <button
            className="lr-tbtn lr-tbtn--play"
            aria-label={np?.playing ? 'Pause' : 'Play'}
            disabled={!!pending['toggle']}
            onClick={() => void act('toggle', { action: np?.playing ? 'pause' : 'play' })}
          >
            <i className={`ti ${np?.playing ? 'ti-player-pause' : 'ti-player-play'}`} aria-hidden="true" />
          </button>
          <button
            className="lr-tbtn"
            aria-label="Next track"
            disabled={!hasTrack}
            onClick={() => void act('next', { action: 'next' }, false)}
          >
            <i className="ti ti-player-skip-forward" aria-hidden="true" />
          </button>
          <button
            className={`lr-tbtn lr-tbtn--sm ${np?.repeat !== 'off' ? 'lr-tbtn--on' : ''}`}
            aria-label={`Repeat: ${np?.repeat ?? 'off'}`}
            disabled={!!pending['repeat'] || !hasTrack}
            onClick={() => void act('repeat', { action: 'repeat', state: nextRepeat })}
          >
            <i
              className={`ti ${np?.repeat === 'track' ? 'ti-repeat-once' : 'ti-repeat'}`}
              aria-hidden="true"
            />
          </button>
        </div>

        {np?.volume !== null && np !== null && (
          <div className="lr-np__vol">
            <i className="ti ti-volume" aria-hidden="true" />
            <input
              type="range"
              min={0}
              max={100}
              value={shownVol}
              aria-label="Volume"
              // onChange (React's per-tick input event) tracks the drag into the
              // draft label; the Spotify call fires once on release. NOT disabled
              // while busy — that cancelled the active drag.
              onChange={(e) => setVolDraft(Number((e.target as HTMLInputElement).value))}
              onPointerUp={(e) =>
                void act('volume', { action: 'volume', level: Number((e.target as HTMLInputElement).value) })
              }
              onKeyUp={(e) => {
                if (RANGE_KEYS.has(e.key))
                  void act('volume', { action: 'volume', level: Number((e.target as HTMLInputElement).value) });
              }}
            />
            <span className="lr-np__volval">{shownVol}%</span>
          </div>
        )}

        {failMsg && <div className="lr-fail">didn't take — {failMsg}</div>}
      </div>

      {/* ── Browse ── */}
      <div className="lr-seg">
        {(
          [
            ['recent', 'ti-history', 'Recent'],
            ['playlists', 'ti-playlist', 'Playlists'],
            ['search', 'ti-search', 'Search'],
          ] as [Tab, string, string][]
        ).map(([key, icon, label]) => (
          <button key={key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>
            <i className={`ti ${icon}`} aria-hidden="true" /> {label}
          </button>
        ))}
      </div>

      {tab === 'search' && (
        <div className="lr-search">
          <i className="ti ti-search" aria-hidden="true" />
          <input
            type="text"
            placeholder="search tracks, artists, playlists…"
            aria-label="Search Spotify"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="lr-search__clear" aria-label="Clear search" onClick={() => setQuery('')}>
              <i className="ti ti-x" aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      <div className="lr-list">
        {tab === 'recent' &&
          (recentFailed && recent === null ? (
            <div className="lr-state">
              Couldn't load recent.{' '}
              <button className="lr-retry" onClick={() => void loadBrowse()}>Retry</button>
            </div>
          ) : recent === null ? (
            <div className="lr-state">Loading…</div>
          ) : recent.length === 0 ? (
            <div className="lr-state">Nothing played recently</div>
          ) : (
            recent.map((r) =>
              browseRow(`${r.played_at}-${r.uri}`, r.art, r.track, 'ti-music', r.track, r.artist, agoLabel(r.played_at, Date.now()), r.uri),
            )
          ))}
        {tab === 'playlists' &&
          (playlistsFailed && playlists === null ? (
            <div className="lr-state">
              Couldn't load playlists.{' '}
              <button className="lr-retry" onClick={() => void loadBrowse()}>Retry</button>
            </div>
          ) : playlists === null ? (
            <div className="lr-state">Loading…</div>
          ) : playlists.length === 0 ? (
            <div className="lr-state">No playlists</div>
          ) : (
            playlists.map((p) =>
              browseRow(
                p.uri,
                p.art,
                p.name,
                'ti-playlist',
                p.name,
                [
                  p.tracks !== null ? `${p.tracks} tracks` : null,
                  ownerDisplay !== null && p.owner === ownerDisplay ? 'you' : p.owner,
                ]
                  .filter(Boolean)
                  .join(' · '),
                '',
                p.uri,
              ),
            )
          ))}
        {tab === 'search' &&
          (query.trim() === '' ? (
            <div className="lr-state">Type above to search — tap a result to play.</div>
          ) : searchFailed ? (
            <div className="lr-state">Couldn't search Spotify</div>
          ) : results === null ? (
            <div className="lr-state">Searching…</div>
          ) : results.length === 0 ? (
            <div className="lr-state">No results</div>
          ) : (
            results.map((s) =>
              browseRow(
                s.uri,
                s.art,
                s.title,
                s.kind === 'playlist' ? 'ti-playlist' : s.kind === 'artist' ? 'ti-user' : 'ti-music',
                s.title,
                s.sub,
                '',
                s.uri,
              ),
            )
          ))}
      </div>

      {/* Journal ghost — visible, inert; wires up when reflections are real. */}
      <div className="lr-journal">
        <i className="ti ti-book" aria-hidden="true" />
        <span className="lr-journal__t">
          Listening journal — Jay's noticings, patterns, tracks marked to lore
        </span>
        <span className="lr-journal__soon">soon</span>
      </div>
    </div>
  );
}
