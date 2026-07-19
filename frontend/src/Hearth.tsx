/**
 * The Hearth — the home control panel.
 *
 * The room half of the HA vertical: Elle drives the house directly here — a
 * glance-and-control panel sized to the house as it actually is (lights,
 * the vacuum, media; no sensor wall). Visual spec is the approved 4 Jul mockup plus
 * Elle's same-day rulings:
 *   - honest PENDING state on every control — visibly working, settles to the
 *     real resulting state, or snaps back with a brief "didn't take". Never an
 *     optimistic fake.
 *   - dimmers fire on release only; the % label tracks the drag live.
 *   - Everything off is a two-tap ("Sure?" arms for 3s).
 *   - Goodnight = all off EXCEPT Bedroom at 20%, playing media paused.
 *   - Vacuum hero: true state verb + room chips (the seven HA areas) firing
 *     clean-area. No battery — the live read doesn't carry one (yet).
 *   - Scene chips are momentary actions, never persistent state.
 *   - Media volume is − / + steppers, 5% per tap.
 *   - Sections are fixed-order but collapsible, each with a LIVE summary line
 *     when collapsed; collapsed state remembered. Glance + vacuum never fold.
 *
 * Same room discipline as the Post Box: mounted in the stage with an `active`
 * prop; fetches only while active; foreground-refresh + gentle poll; last-good
 * on a failed refresh — the panel never blanks.
 */

import { useCallback, useRef, useState } from 'react';
import { api } from './api';
import { useVisiblePoll, useSettledAction, useReadSequence, agoLabel } from './hooks';

// ── The /api/home payload (mirrors backend/src/home.ts) ─────────────────────
type HomeLight = { name: string; area: string | null; on: boolean; brightness: number };
type HomeMedia = {
  name: string;
  area: string | null;
  state: string;
  volume: number | null;
  kind: 'tv' | 'speaker';
};
type HomeVacuum = { name: string; state: string };
type HomeState = {
  lights: HomeLight[];
  vacuums: HomeVacuum[];
  media: HomeMedia[];
};

// Fixed section order — predictability is a feature in this house. Only areas
// with exposed lights get a section; audio has its own area-grouped section.
const AREA_ORDER = ['Living Room', 'Kitchen', 'Bedroom', 'Guest Bedroom'];
const AREA_ICON: Record<string, string> = {
  'Living Room': 'ti-sofa',
  Kitchen: 'ti-tools-kitchen-2',
  Bedroom: 'ti-bed',
  'Guest Bedroom': 'ti-bed',
};

// Scene chips — WAS a hardcoded four; NOW the hearth.registry config, riding
// the /api/home payload (name doubles as label and API identifier). Add a
// scene in the Fuse Box, get a chip here on the next poll.
type SceneChip = { name: string; icon: string };

// The device rosters (18 Jul extension) — WAS a hardcoded seven-room list
// and a flat media strip; NOW hearth.vacuums + hearth.audio config riding the
// same payload. Remove an area in the Fuse Box, the chip is gone next poll.
// The vacuum roster names each vacuum's cleanable areas (HA can't — verified);
// the audio roster is two-level (area → speakers) with Everywhere its own
// deliberate whole-house group, never just another area.
type VacuumDef = { name: string; areas: string[] };
type AudioRoster = {
  everywhere: string | null;
  areas: Array<{ area: string; speakers: string[] }>;
};
type Rosters = { vacuums: VacuumDef[]; audio: AudioRoster };

const VOLUME_STEP = 5; // Elle proposed 2, took the 5% recommendation (4 Jul)
const POLL_MS = 30_000;
// After this long since the last good read (or 2 consecutive failures), the
// stale ribbon owns up that the panel isn't live.
const STALE_MS = 60_000;
// Read-after-write settle: a control's follow-up read at +200ms raced HA's
// state machine and reported the OLD state (seen live, 4 Jul — light on,
// panel said Off). Pending holds this long before the truth-read fires.
const SETTLE_MS = 1_000;
const FAILED_FLASH_MS = 2_500;
const ARM_MS = 3_000;
const COLLAPSED_KEY = 'vale-hearth-collapsed';

// Keys that move a range input — the only ones that should commit a dimmer on
// keyUp (so Tab in/out of the slider doesn't fire a redundant HA call).
const RANGE_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown',
]);

// The vacuum's state, worded for the hero. Unknown states show verbatim rather
// than lying with a mapped guess.
function vacuumVerb(state: string): string {
  switch (state) {
    case 'docked': return 'Docked';
    case 'cleaning': return 'Cleaning';
    case 'returning': return 'Returning to dock';
    case 'paused': return 'Paused';
    case 'idle': return 'Idle';
    case 'error': return 'Error';
    default: return state;
  }
}

function mediaVerb(state: string): string {
  switch (state) {
    case 'idle': return 'Idle';
    case 'playing': return 'Playing';
    case 'paused': return 'Paused';
    case 'unavailable': return 'Unavailable';
    case 'off': return 'Off';
    default: return state;
  }
}

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

export function Hearth({ active }: { active: boolean }) {
  // Last-good house state; null until the first read lands. error only styles
  // the empty state — once we have data, a failed refresh keeps last-good.
  const [home, setHome] = useState<HomeState | null>(null);
  const [scenes, setScenes] = useState<SceneChip[]>([]);
  const [rosters, setRosters] = useState<Rosters | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // Dimmer drag drafts: % label follows the finger, the call fires on release.
  const [dimDraft, setDimDraft] = useState<Record<string, number>>({});

  // Everything-off two-tap arm.
  const [armedOff, setArmedOff] = useState(false);
  const armTimer = useRef<number | null>(null);

  // Momentary scene-chip flash.
  const [flashScene, setFlashScene] = useState<string | null>(null);

  // Collapsed sections, remembered.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);

  // Sequence-safe read: a slow older read bails rather than overwriting a newer
  // one's fresh state. Returns whether the read landed (drives the stale ribbon).
  const readSeq = useReadSequence();
  const refresh = useCallback(async (): Promise<boolean> => {
    const s = readSeq.begin();
    try {
      const res = await api(`/home`);
      const data = await res.json();
      if (!readSeq.isCurrent(s)) return true; // a newer read superseded this one
      if (data.ok && data.home) {
        setHome(data.home);
        if (Array.isArray(data.scenes)) setScenes(data.scenes);
        if (data.rosters) setRosters(data.rosters);
        setLoadFailed(false);
        return true;
      }
      setLoadFailed(true); // styles the empty state only; last-good stays
      return false;
    } catch (err) {
      console.error('Failed to load house state:', err);
      if (readSeq.isCurrent(s)) setLoadFailed(true);
      return false;
    }
  }, [readSeq]);

  // Active-gated poll (jitter + error backoff); its health drives the ribbon.
  const { lastSuccessAt, failing } = useVisiblePoll(refresh, POLL_MS, active);

  // Honest per-control pending + didn't-take flash + settle/trailing truth-read.
  // Keyed, so one control settling never locks the others. trailingMs catches the
  // slow Nabu Casa settle (turn-off took ~2-4s, seen live) without waiting for the poll.
  const { run, pending, failed } = useSettledAction({
    settleMs: SETTLE_MS,
    trailingMs: 2_500,
    flashMs: FAILED_FLASH_MS,
    active,
    refresh,
  });

  // One control action: fire, then the hook re-reads so the tile shows the real
  // resulting state — never a fake success. The dimmer draft clears once settled.
  const act = useCallback(
    (key: string, path: string, body: Record<string, unknown>) =>
      run(key, async () => {
        const res = await api(`/home/${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error ?? 'failed');
      }).finally(() => {
        setDimDraft((d) => {
          const { [key]: _drop, ...rest } = d;
          return rest;
        });
      }),
    [run],
  );

  // `to` pins the next state — the audio subgroups default folded (their read
  // treats undefined as folded), so their toggle passes the explicit target.
  function toggleCollapsed(section: string, to?: boolean) {
    setCollapsed((c) => {
      const next = { ...c, [section]: to ?? !c[section] };
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable — collapse still works for the session */
      }
      return next;
    });
  }

  function everythingOff() {
    if (!armedOff) {
      setArmedOff(true);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => setArmedOff(false), ARM_MS);
      return;
    }
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmedOff(false);
    void act('bulk', 'all-off', {});
  }

  function runScene(key: string) {
    setFlashScene(key);
    setTimeout(() => setFlashScene((s) => (s === key ? null : s)), 500);
    void act('scene', 'scene', { scene: key });
  }

  // ── Derived glance ─────────────────────────────────────────────────────────
  const lights = home?.lights ?? [];
  const media = home?.media ?? [];
  const vacuums = home?.vacuums ?? [];
  const onLights = lights.filter((l) => l.on);
  const playing = media.filter((m) => m.state === 'playing');
  const vacBusy = (s: string) => s === 'cleaning' || s === 'returning';
  const busyVacs = vacuums.filter((v) => vacBusy(v.state));

  const glanceQuiet = onLights.length === 0 && playing.length === 0 && busyVacs.length === 0;
  const glanceText = glanceQuiet
    ? 'All quiet.'
    : [
        onLights.length > 0 ? `${onLights.length} light${onLights.length > 1 ? 's' : ''} on` : null,
        ...busyVacs.map((v) => `${v.name} ${v.state === 'cleaning' ? 'cleaning' : 'heading home'}`),
        playing.length > 0 ? `${playing.length} playing` : null,
      ]
        .filter(Boolean)
        .join(' · ') + '.';
  const glanceSub = [
    onLights.length === 0 ? 'Every light off' : `Lights: ${onLights.map((l) => l.name).join(', ')}`,
    ...vacuums.map((v) => `${v.name} ${vacuumVerb(v.state).toLowerCase()}`),
    playing.length === 0 ? 'media idle' : `playing: ${playing.map((m) => m.name).join(', ')}`,
  ]
    .filter(Boolean)
    .join(' · ');

  // Live collapsed-section summary — lights only; audio has its own section.
  function areaSummary(area: string): string {
    const al = lights.filter((l) => l.area === area);
    if (!al.length) return 'nothing here';
    const n = al.filter((l) => l.on).length;
    return n === 0 ? 'lights off' : `${n} light${n > 1 ? 's' : ''} on`;
  }

  // ── Row renderers ──────────────────────────────────────────────────────────

  function lightRow(l: HomeLight) {
    const key = `light:${l.name}`;
    const busy = pending[key] === true;
    const bad = failed[key] === true;
    const shownPct = dimDraft[key] ?? l.brightness;
    return (
      <div
        key={l.name}
        className={`hh-ctl ${l.on ? 'hh-ctl--on' : ''} ${busy ? 'hh-busy' : ''} ${bad ? 'hh-bad' : ''}`}
      >
        <div className="hh-ctl__row">
          <div className="hh-ctl__icon">
            <i className="ti ti-bulb" aria-hidden="true" />
          </div>
          <div className="hh-ctl__body">
            <div className="hh-ctl__name">{l.name}</div>
            <div className="hh-ctl__state">
              {bad ? "didn't take" : busy ? 'working…' : l.on ? `On · ${l.brightness}%` : 'Off'}
            </div>
          </div>
          <button
            className={`hh-toggle ${l.on ? 'hh-toggle--on' : ''}`}
            aria-label={`${l.name} ${l.on ? 'off' : 'on'}`}
            disabled={busy}
            onClick={() => void act(key, 'light', { name: l.name, on: !l.on })}
          />
        </div>
        <div className={`hh-dim ${l.on ? '' : 'hh-dim--off'}`}>
          <i className="ti ti-sun-low" aria-hidden="true" />
          <input
            type="range"
            min={0}
            max={100}
            value={shownPct}
            aria-label={`${l.name} brightness`}
            // onChange (React's per-tick input event) tracks the drag into the
            // draft label; the HA call fires once on release, never mid-gesture.
            // NOT disabled while busy — that cancelled the active drag.
            onChange={(e) =>
              setDimDraft((d) => ({ ...d, [key]: Number((e.target as HTMLInputElement).value) }))
            }
            onPointerUp={(e) =>
              void act(key, 'light', { name: l.name, brightness: Number((e.target as HTMLInputElement).value) })
            }
            onKeyUp={(e) => {
              if (RANGE_KEYS.has(e.key))
                void act(key, 'light', { name: l.name, brightness: Number((e.target as HTMLInputElement).value) });
            }}
          />
          <span className="hh-dim__val">{shownPct}%</span>
        </div>
      </div>
    );
  }

  // A media control row. The label defaults to the device's HA name; the audio
  // section passes the AREA name for a one-speaker room ("address the room"),
  // with the device named in the state line so nothing is hidden. Icon comes
  // from the payload's kind + the roster's everywhere marker — never from a
  // hardcoded device name.
  function mediaRow(m: HomeMedia, opts?: { label?: string; everywhere?: boolean }) {
    const key = `media:${m.name}`;
    const busy = pending[key] === true;
    const bad = failed[key] === true;
    const unavailable = m.state === 'unavailable';
    const isPlaying = m.state === 'playing';
    const label = opts?.label ?? m.name;
    const vol = m.volume;
    return (
      <div
        key={m.name}
        className={`hh-media ${unavailable ? 'hh-media--unavail' : ''} ${busy ? 'hh-busy' : ''} ${bad ? 'hh-bad' : ''}`}
      >
        <div className="hh-media__icon">
          <i
            className={`ti ${opts?.everywhere ? 'ti-broadcast' : m.kind === 'tv' ? 'ti-device-tv' : 'ti-speakerphone'}`}
            aria-hidden="true"
          />
        </div>
        <div className="hh-media__body">
          <div className="hh-media__name">{label}</div>
          <div className="hh-media__state">
            {label !== m.name ? `${m.name} · ` : ''}
            {bad ? "didn't take" : busy ? 'working…' : mediaVerb(m.state)}
            {!bad && !busy && vol !== null && !unavailable ? ` · vol ${vol}%` : ''}
          </div>
        </div>
        <div className="hh-media__transport">
          <button
            className="hh-mbtn"
            aria-label={isPlaying ? `Pause ${label}` : `Play ${label}`}
            disabled={busy || unavailable}
            onClick={() => void act(key, 'media', { name: m.name, action: isPlaying ? 'pause' : 'play' })}
          >
            <i className={`ti ${isPlaying ? 'ti-player-pause' : 'ti-player-play'}`} aria-hidden="true" />
          </button>
          <button
            className="hh-mbtn"
            aria-label={`${label} volume down`}
            disabled={busy || unavailable || vol === null}
            onClick={() =>
              void act(key, 'media', { name: m.name, action: 'volume', level: (vol ?? 0) - VOLUME_STEP })
            }
          >
            <i className="ti ti-minus" aria-hidden="true" />
          </button>
          <button
            className="hh-mbtn"
            aria-label={`${label} volume up`}
            disabled={busy || unavailable || vol === null}
            onClick={() =>
              void act(key, 'media', { name: m.name, action: 'volume', level: (vol ?? 0) + VOLUME_STEP })
            }
          >
            <i className="ti ti-plus" aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  function areaSection(area: string) {
    const al = lights.filter((l) => l.area === area);
    if (al.length === 0) return null;
    const folded = collapsed[area] === true;
    const nOn = al.filter((l) => l.on).length;
    return (
      <div className="hh-area" key={area}>
        <button
          className={`hh-area__head ${folded ? 'hh-area__head--folded' : ''}`}
          aria-expanded={!folded}
          onClick={() => toggleCollapsed(area)}
        >
          <span className="hh-area__name">
            <i className={`ti ${AREA_ICON[area] ?? 'ti-home'}`} aria-hidden="true" /> {area}
          </span>
          <span className="hh-area__meta">
            {folded ? areaSummary(area) : `${nOn} on`}
            <i className={`ti ${folded ? 'ti-chevron-right' : 'ti-chevron-down'}`} aria-hidden="true" />
          </span>
        </button>
        {!folded && al.map(lightRow)}
      </div>
    );
  }

  // ── The audio section's shape, from the roster + live state ────────────────
  // Everywhere first (its own group, deliberately), then the roster's areas.
  // A roster device missing from the live read still renders — as unavailable,
  // honestly — rather than silently vanishing from the panel.
  const liveMedia = (name: string): HomeMedia =>
    media.find((m) => m.name === name) ?? {
      name,
      area: null,
      state: 'unavailable',
      volume: null,
      kind: 'speaker',
    };
  const audio = rosters?.audio ?? null;
  const everywhereRow = audio?.everywhere ? liveMedia(audio.everywhere) : null;
  const audioFolded = collapsed['house-audio'] === true;
  const audioSummary = audio
    ? [
        ...(everywhereRow && everywhereRow.state !== 'unavailable'
          ? [`${everywhereRow.name} ${mediaVerb(everywhereRow.state).toLowerCase()}`]
          : []),
        ...audio.areas.flatMap((a) =>
          a.speakers
            .map(liveMedia)
            .filter((m) => m.state === 'playing')
            .map((m) => `${m.name} playing`),
        ),
      ].join(' · ') || 'all quiet'
    : '';

  // The vacuums, roster-first: the roster names them and carries their chips;
  // the live read supplies the state. Not in the live read = unavailable.
  const rosterVacuums = (rosters?.vacuums ?? []).map((v) => ({
    def: v,
    state: vacuums.find((lv) => lv.name === v.name)?.state ?? null,
  }));

  return (
    <div className="hearth">
      {home === null ? (
        <div className="hh-state">
          {loadFailed ? "Couldn't reach the house" : 'Reading the house…'}
        </div>
      ) : (
        <>
          {/* Stale honesty — a quiet ribbon when the panel isn't live, so a
              frozen last-good never masquerades as current. */}
          {lastSuccessAt !== null && (failing || Date.now() - lastSuccessAt > STALE_MS) && (
            <div className="room-stale">
              <i className="ti ti-cloud-off" aria-hidden="true" /> updated {agoLabel(lastSuccessAt)}
            </div>
          )}
          {/* Glance strip — never folds */}
          <div className="hh-glance">
            <div className="hh-glance__top">
              <span
                className={`hh-glance__dot ${glanceQuiet ? '' : 'hh-glance__dot--active'}`}
                aria-hidden="true"
              />
              <div>
                <div className="hh-glance__text">{glanceText}</div>
                <div className="hh-glance__sub">{glanceSub}</div>
              </div>
            </div>
            <div className="hh-glance__actions">
              <button
                className={`hh-action ${armedOff ? 'hh-action--armed' : ''} ${pending['bulk'] ? 'hh-busy' : ''}`}
                disabled={pending['bulk'] === true}
                onClick={everythingOff}
              >
                <i className="ti ti-power" aria-hidden="true" />
                {armedOff ? 'Sure? Everything off' : 'Everything off'}
              </button>
              <button
                className={`hh-action ${pending['goodnight'] ? 'hh-busy' : ''}`}
                disabled={pending['goodnight'] === true}
                onClick={() => void act('goodnight', 'goodnight', {})}
              >
                <i className="ti ti-moon" aria-hidden="true" />
                Goodnight
              </button>
            </div>
            {failed['bulk'] && <div className="hh-glance__fail">didn't take — house unchanged</div>}
            {failed['goodnight'] && <div className="hh-glance__fail">didn't take — house unchanged</div>}
          </div>

          {/* Vacuum heroes — never fold. One card per roster vacuum; the chips
              are the roster's areas for THAT vacuum (remove one in the Fuse
              Box, it's gone next poll — no hardcoded room list survives). */}
          {rosterVacuums.map(({ def, state }) => {
            const key = `vacuum:${def.name}`;
            const vPending = pending[key] === true;
            const vBad = failed[key] === true;
            const vBusyNow = state !== null && vacBusy(state);
            const gone = state === null;
            return (
              <div
                key={def.name}
                className={`hh-vac ${vPending ? 'hh-busy' : ''} ${vBad ? 'hh-bad' : ''}`}
              >
                <div className="hh-vac__row">
                  <div className="hh-vac__icon">
                    <i className="ti ti-robot" aria-hidden="true" />
                  </div>
                  <div className="hh-vac__body">
                    <div className="hh-vac__name">{def.name}</div>
                    <div className="hh-vac__state">
                      {vBad
                        ? "didn't take"
                        : vPending
                          ? 'working…'
                          : gone
                            ? 'Unavailable'
                            : vacuumVerb(state)}
                    </div>
                  </div>
                  <button
                    className="hh-vac__btn"
                    disabled={vPending || gone}
                    onClick={() =>
                      void act(key, 'vacuum', {
                        action: vBusyNow ? 'dock' : 'clean',
                        name: def.name,
                      })
                    }
                  >
                    {vBusyNow ? 'Dock' : 'Clean'}
                  </button>
                </div>
                <div className="hh-vac__rooms">
                  {def.areas.map((room) => (
                    <button
                      key={room}
                      className="hh-chip hh-chip--sm"
                      disabled={vPending || gone}
                      onClick={() =>
                        void act(key, 'vacuum', {
                          action: 'clean_area',
                          area: room,
                          name: def.name,
                        })
                      }
                    >
                      {room}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}

          {/* Scene chips — house-level, under the vacuum, never folded away. They
              lived inside the Living Room section when scenes WERE Living
              Room presets; now a scene can drive any lights (Elle's Cooking
              scene, 18 Jul), so the chips sit where every scene is one tap
              regardless of which rooms it touches. */}
          {scenes.length > 0 && (
            <div className="hh-scenes hh-scenes--bar">
              {scenes.map((s) => (
                <button
                  key={s.name}
                  className={`hh-chip ${flashScene === s.name ? 'hh-chip--flash' : ''}`}
                  disabled={pending['scene'] === true}
                  onClick={() => runScene(s.name)}
                >
                  <i className={`ti ${s.icon}`} aria-hidden="true" /> {s.name}
                </button>
              ))}
            </div>
          )}

          {/* Area sections — fixed order, collapsible, live summaries */}
          {AREA_ORDER.map(areaSection)}

          {/* Audio — by area (18 Jul brief): Everywhere is its own group above
              the per-area rows, deliberately. One speaker in a room = one row
              addressed by the room; several = the room expands to pick. */}
          {audio && (everywhereRow || audio.areas.length > 0) && (
            <div className="hh-area">
              <button
                className={`hh-area__head ${audioFolded ? 'hh-area__head--folded' : ''}`}
                aria-expanded={!audioFolded}
                onClick={() => toggleCollapsed('house-audio')}
              >
                <span className="hh-area__name">
                  <i className="ti ti-speakerphone" aria-hidden="true" /> Audio
                </span>
                <span className="hh-area__meta">
                  {audioFolded ? audioSummary : ''}
                  <i
                    className={`ti ${audioFolded ? 'ti-chevron-right' : 'ti-chevron-down'}`}
                    aria-hidden="true"
                  />
                </span>
              </button>
              {!audioFolded && (
                <>
                  {everywhereRow && mediaRow(everywhereRow, { everywhere: true })}
                  {audio.areas.map((a) => {
                    const rows = a.speakers.map(liveMedia);
                    if (rows.length === 1) {
                      // Address the room: the row wears the area's name, the
                      // device stays named in its state line.
                      return mediaRow(rows[0], { label: a.area });
                    }
                    const subKey = `audio:${a.area}`;
                    const subFolded = collapsed[subKey] !== false; // folded by default
                    const playingHere = rows.filter((m) => m.state === 'playing').length;
                    return (
                      <div className="hh-audio-sub" key={a.area}>
                        <button
                          className="hh-audio-sub__head"
                          aria-expanded={!subFolded}
                          onClick={() => toggleCollapsed(subKey, !subFolded)}
                        >
                          <span>
                            {a.area} · {rows.length} speakers
                            {playingHere > 0 ? ` · ${playingHere} playing` : ''}
                          </span>
                          <i
                            className={`ti ${subFolded ? 'ti-chevron-right' : 'ti-chevron-down'}`}
                            aria-hidden="true"
                          />
                        </button>
                        {!subFolded && rows.map((m) => mediaRow(m))}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
