import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { PostBox } from './PostBox';
import { Hearth } from './Hearth';
import { ListeningRoom } from './ListeningRoom';
import { Gallery } from './Gallery';
import { FuseBox } from './FuseBox';
import { api, apiUrl } from './api';
import { agoLabel, useVisiblePoll } from './hooks';
import {
  refreshDecor,
  DECOR_CHANGED_EVENT,
  getDecorMode,
  setDecorMode,
  type DecorMode,
} from './decor';
import {
  IdentityContext,
  IDENTITY_CHANGED_EVENT,
  fetchIdentity,
  storedIdentity,
  type Identity,
} from './identity';
import { SetupWizard } from './SetupWizard';

// Labels for the six moods; the baseline resolves the user's name from
// Identity at render ("Just Elle" here, "Just Steff" there).
const MOODS = [
  'Just {user}',
  'Locked In',
  'Low Spoons',
  'Bad Day',
  'Bratty',
  'Leave Me Alone',
];

// The backend's canonical snake_case ids, in the same order as MOODS — the wire
// form Jay reads. Keep aligned with the taxonomy / backend mood module.
const MOOD_IDS = [
  'just_elle',
  'locked_in',
  'low_spoons',
  'bad_day',
  'bratty',
  'leave_me_alone',
];

// The Workshop's three tools, all wired — their card subtitles show live data,
// computed in the render. Each `sub` is a neutral fallback shown only until that
// tool's live data loads — never an invented number. (Mail retired into the Post
// Box room when that shipped — a full Gmail client deserves a room, not a tile.)
const WORKSHOP_TOOLS = [
  { name: 'Notion', icon: 'ti-notebook', sub: 'Recent & search' },
  { name: 'Calendar', icon: 'ti-calendar', sub: '' },
  { name: 'Projects', icon: 'ti-checklist', sub: 'Project tracker' },
];

// The shape of a room as it comes back from the backend.
type Room = {
  id: string;
  name: string;
  display_name: string;
  icon: string;
  status: string;
};

// A message in the conversation. id is a number for turns typed this session
// (Date.now()) or a string uuid for turns restored from the backend.
// created_at is the message's timestamp (ISO). From the server on restore; a
// client send-time as interim on a just-sent message, reconciled to the server
// value once persisted. Optional so a stray construction never breaks — the
// feed degrades quietly when it's absent. Never sent back to the brain (the
// /api/message body maps to just { from, text }), so the stored text is
// byte-for-byte unchanged.
type Message = {
  id: number | string;
  from: 'elle' | 'jay';
  text: string;
  created_at?: string;
  // Client-fabricated failure bubble ("Couldn't reach Jay…"). Rendered locally,
  // never sent anywhere, and dropped on the next history reconcile — so a
  // transient error never becomes part of Jay's canon.
  local?: boolean;
  // A voice note's audio attachment (metadata.voice on the server row). The
  // text is always the transcript — the audio never replaces it.
  voice?: { key: string; chars?: number };
  // A generated image's row reference (metadata.image, from generate_image).
  // The text stays Jay's intent; the client resolves the id against the
  // Gallery and renders the picture inline once the pipeline completes.
  image?: { id: string };
};

// Which capabilities the install holds (GET /api/readiness) — the rooms'
// honest empty states key off this. null = not loaded; rooms render normally
// until the truth arrives (never a false "needs its key" flash).
type Readiness = {
  anthropic: boolean;
  elevenlabs: boolean;
  getimg: boolean;
  ha: boolean;
  notion: boolean;
  openrouter: boolean;
  spotify: boolean;
  gmail: boolean;
  hearth_rosters: boolean;
  workshop_mappings: boolean;
};

// The uniform "this room needs …" state (Haven degradation pass): one shared
// component, honest about exactly which key/config is missing and where in the
// Fuse Box it's set. Desktop links straight to the panel; a phone says where
// to go (the Fuse Box is desktop-only by design).
function RoomNeeds({
  icon,
  room,
  needs,
  circuit,
  onOpenFuseBox,
}: {
  icon: string;
  room: string;
  needs: string;
  circuit: string;
  onOpenFuseBox: (() => void) | null;
}) {
  return (
    <div className="room-needs" role="status">
      <i className={`ti ${icon} room-needs__icon`} aria-hidden="true" />
      <div className="room-needs__title">{room} isn't wired up yet</div>
      <div className="room-needs__text">
        This room needs {needs}. Nothing is broken — the circuit just hasn't
        been flipped.
      </div>
      {onOpenFuseBox ? (
        <button className="room-needs__go" onClick={onOpenFuseBox}>
          <i className="ti ti-bolt" aria-hidden="true" /> Open the Fuse Box → {circuit}
        </button>
      ) : (
        <div className="room-needs__hint">
          Set it in the Fuse Box → {circuit} (open this house on a desktop).
        </div>
      )}
    </div>
  );
}

// Chromium fires this before its install prompt; not in the TS DOM lib yet.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

const INSTALL_DISMISSED_KEY = 'vale-install-dismissed';

// The composer grows with what Elle writes, up to about seven lines; past
// that it scrolls internally.
const COMPOSER_MAX_HEIGHT = 160;

// Markdown is rendered on display only — the stored/sent text stays raw.
// react-markdown ignores raw HTML by default, so nothing gets injected.
// remark-breaks keeps single newlines as line breaks, matching how the
// composer is written in (Enter = new line).
const MD_PLUGINS = [remarkGfm, remarkBreaks];
const MD_COMPONENTS: Components = {
  // Links open outside the conversation, never navigating the app away.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

// ── Inline generated image (metadata.image on a Jay message) ────────────────
// The Front Room's view of a generate_image row: skeleton while the pipeline
// runs (2.5s poll against the Gallery, stopping the moment the row settles),
// the picture once complete, an honest note if it errored or was deleted. The
// full image lives in the Gallery — this card links there rather than
// duplicating the room.
type InlineImageRow = {
  status: 'pending' | 'complete' | 'error';
  storage_path: string | null;
  thumbnail_path: string | null;
  error: string | null;
  prompt_raw: string;
};
const INLINE_IMG_POLL_MS = 2_500;
const INLINE_IMG_MAX_POLLS = 360; // ~15 min, matched to the pipeline's own ceiling

function InlineImage({ imageId, onOpenGallery }: { imageId: string; onOpenGallery: () => void }) {
  const [row, setRow] = useState<InlineImageRow | null | 'missing'>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let polls = 0;
    const poll = async () => {
      polls += 1;
      try {
        const res = await api(`/gallery/images?ids=${imageId}`);
        const data = await res.json();
        if (cancelled) return;
        if (data.ok) {
          const r = (data.images ?? [])[0] as InlineImageRow | undefined;
          if (!r) {
            setRow('missing'); // deleted from the Gallery — stop asking
            return;
          }
          setRow(r);
          if (r.status !== 'pending') return; // settled — done polling
        }
      } catch {
        /* transient — keep polling */
      }
      if (polls < INLINE_IMG_MAX_POLLS) timer = window.setTimeout(poll, INLINE_IMG_POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [imageId]);

  if (row === 'missing') return null; // deleted: the text (the intent) still stands
  if (row === null || row.status === 'pending') {
    return (
      <div className="imsg imsg--pending">
        <i className="ti ti-photo" aria-hidden="true" />
        <span>making it…</span>
      </div>
    );
  }
  if (row.status === 'error') {
    return (
      <div className="imsg imsg--error">
        <i className="ti ti-photo-x" aria-hidden="true" />
        <span>didn't render — it's in the Gallery to retry</span>
        <button onClick={onOpenGallery}>Gallery</button>
      </div>
    );
  }
  const src = row.thumbnail_path ?? row.storage_path;
  return (
    <div className="imsg">
      {src && (
        <img src={apiUrl(`/gallery/file/${src}`)} alt={row.prompt_raw.slice(0, 80)} loading="lazy" />
      )}
      <button className="imsg__link" onClick={onOpenGallery}>
        <i className="ti ti-photo" aria-hidden="true" /> View in Gallery
      </button>
    </div>
  );
}

// ── Next event (ambient "next" tile) ────────────────────────────────────────
// The single upcoming event from /api/calendar that feeds the ambient bar.
type CalEvent = { title: string; starts_at: string; is_datetime: boolean };

// THE banked trap (see the build brief): everything Elle sees is Perth. These
// formatters pin Australia/Perth explicitly, so an all-day row stored at
// Perth-midnight renders on the right date no matter what timezone the browser
// itself is in — the date never shifts under us.
const PERTH_TZ = 'Australia/Perth';
const DAY_KEY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: PERTH_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}); // → "2026-06-15", a stable per-day key for the is-it-today check
const WEEKDAY_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: PERTH_TZ,
  weekday: 'short',
}); // → "Mon"
const TIME_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: PERTH_TZ,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

// "9pm" / "7:15am" — matches the ambient tile's clipped style, minutes dropped
// on the hour.
function perthTime(iso: string): string {
  const parts = TIME_FMT.formatToParts(new Date(iso));
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const period = (parts.find((p) => p.type === 'dayPeriod')?.value ?? '').toLowerCase();
  return minute === '00' ? `${hour}${period}` : `${hour}:${minute}${period}`;
}

// The ambient tile value, e.g. "Reports to Admin · all day" or "Talkingtons ·
// Sat 9pm". Today drops the weekday ("9pm" / "all day"); future days lead with
// it. All Perth, so the day never drifts.
function nextLabel(ev: CalEvent, now: Date): string {
  const when = new Date(ev.starts_at);
  const isToday = DAY_KEY_FMT.format(when) === DAY_KEY_FMT.format(now);
  let suffix: string;
  if (ev.is_datetime) {
    const time = perthTime(ev.starts_at);
    suffix = isToday ? time : `${WEEKDAY_FMT.format(when)} ${time}`;
  } else {
    suffix = isToday ? 'all day' : WEEKDAY_FMT.format(when);
  }
  return `${ev.title} · ${suffix}`;
}

// ── Ambient weather tile — location helpers ─────────────────────────────────
// One device GPS fix, or null. All three failure modes (permission denied,
// position unavailable, timeout) fall through the error callback to null so the
// caller can take the IP-fallback path — and the timeout means it never hangs
// the tile. maximumAge lets a recent fix be reused, easing battery and the
// permission prompt.
function getDeviceFix(): Promise<GeolocationPosition | null> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos),
      () => resolve(null),
      { timeout: 8000, maximumAge: 10 * 60 * 1000 },
    );
  });
}

// The device-path place name is resolved client-side from the precise fix via
// BigDataCloud's free, keyless reverse-geocode-client endpoint (no API key, no
// secret). Its fair-use policy requires calls to use the device's *current*
// location — so we only ever call with a fresh getCurrentPosition fix, and we
// cache the resulting NAME hard (a name for a coordinate is effectively static)
// keyed by rounded coords. A refresh then re-fetches only the number; a cache
// hit means we don't call the geocoder at all. We never replay stored coords
// back into the API, which is what the fair-use policy forbids.
const PLACE_CACHE_KEY = 'vale_weather_place_v1';
const PLACE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a week — a place name barely moves
const placeCoordKey = (lat: number, lon: number) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

async function placeNameFor(lat: number, lon: number): Promise<string | null> {
  const key = placeCoordKey(lat, lon);

  try {
    const raw = localStorage.getItem(PLACE_CACHE_KEY);
    if (raw) {
      const c = JSON.parse(raw) as { key: string; place: string; at: number };
      if (c.key === key && Date.now() - c.at < PLACE_CACHE_TTL_MS) return c.place;
    }
  } catch {
    /* a corrupt entry just means a cache miss — fall through and re-resolve */
  }

  // Cache miss — reverse-geocode the current fix (fair-use compliant).
  const url =
    `https://api.bigdatacloud.net/data/reverse-geocode-client` +
    `?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`reverse-geocode ${res.status}`);
  const body = (await res.json()) as {
    locality?: string;
    city?: string;
    principalSubdivision?: string;
  };
  // Most granular first (a suburb/town like "Halls Head"), then the broader
  // city, then the region — whichever first has a name.
  const place = body.locality || body.city || body.principalSubdivision || null;
  if (place) {
    try {
      localStorage.setItem(PLACE_CACHE_KEY, JSON.stringify({ key, place, at: Date.now() }));
    } catch {
      /* storage unavailable/full — fine, we just re-resolve next miss */
    }
  }
  return place;
}

// ── Workshop calendar agenda ────────────────────────────────────────────────
// One upcoming event for the Workshop calendar tool's agenda view.
type AgendaEvent = {
  id: number;
  title: string;
  starts_at: string;
  ends_at: string | null;
  is_datetime: boolean;
  kind: string;
  source: string;
  course: string | null;
  url: string | null;
  recurs_annual: boolean | null;
};
// A rendered event line and a day-section of them.
type AgendaItem = { key: string; title: string; meta: string; spine: string };
type AgendaSection = { key: string; label: string; isToday: boolean; items: AgendaItem[] };

// Today + the next few days each get their own header; everything beyond falls
// into one "Later" bucket (each row showing its date). The horizon caps the
// fetch. Both are easy dials if the split ever wants tuning.
const AGENDA_NEAR_DAYS = 7;
const AGENDA_HORIZON_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Perth-tz formatters for the agenda — "Sat 30 May" headers and 24-hour mono
// times, matching the 30 May mockup.
const AGENDA_DAY_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: PERTH_TZ,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const AGENDA_TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: PERTH_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

// Spine colour by type — the v1 mapping (Elle to confirm): teal for personal
// (gcal events + tasks), bronze for school (assessments + school events), sage
// for recurring birthdays, muted for the lesson backbone.
function agendaSpine(kind: string, source: string): string {
  if (kind === 'lesson') return 'agenda__spine--muted';
  if (kind === 'birthday') return 'agenda__spine--sage';
  if (kind === 'assessment') return 'agenda__spine--bronze';
  if (kind === 'task') return 'agenda__spine--teal';
  if (kind === 'event') {
    return source === 'gcal' ? 'agenda__spine--teal' : 'agenda__spine--bronze';
  }
  return 'agenda__spine--muted';
}

// Course without the trailing year, e.g. "9.1 - 2026" → "9.1".
function courseShort(course: string | null): string {
  return (course ?? '').split(' - ')[0].trim();
}

// Group events into Perth-day sections. Within a day an all-day event sorts to
// the END of its Perth day (the tile's timed-first refinement), so an upcoming
// timed event surfaces ahead of the all-day banner. Days beyond the near window
// collapse into a single "Later" bucket whose rows carry their own date.
function groupAgenda(events: AgendaEvent[], now: Date): AgendaSection[] {
  const todayKey = DAY_KEY_FMT.format(now);
  const horizonKey = DAY_KEY_FMT.format(new Date(now.getTime() + AGENDA_HORIZON_DAYS * DAY_MS));
  const nearKeys: string[] = [];
  for (let i = 0; i < AGENDA_NEAR_DAYS; i++) {
    nearKeys.push(DAY_KEY_FMT.format(new Date(now.getTime() + i * DAY_MS)));
  }

  const sections = new Map<string, AgendaSection>();
  const sortAt = (e: AgendaEvent) => {
    const t = new Date(e.starts_at).getTime();
    return e.is_datetime ? t : t + DAY_MS; // all-day to the end of its day
  };
  const ordered = [...events].sort((a, b) => sortAt(a) - sortAt(b));

  for (const e of ordered) {
    const when = new Date(e.starts_at);
    const dayKey = DAY_KEY_FMT.format(when);
    if (dayKey < todayKey || dayKey > horizonKey) continue; // outside the window
    const isLater = !nearKeys.includes(dayKey);
    const sectionKey = isLater ? 'later' : dayKey;
    if (!sections.has(sectionKey)) {
      const label = isLater
        ? 'Later'
        : dayKey === todayKey
          ? `Today · ${AGENDA_DAY_FMT.format(when)}`
          : AGENDA_DAY_FMT.format(when);
      sections.set(sectionKey, { key: sectionKey, label, isToday: dayKey === todayKey, items: [] });
    }

    const time = AGENDA_TIME_FMT.format(when);
    // Lessons and assessments show their class, so the same title across two
    // classes (e.g. "Chemical Reactions Test · 9.1" vs "· 9.2") stays distinct.
    const course =
      e.kind === 'lesson' || e.kind === 'assessment' ? courseShort(e.course) : '';
    let meta = isLater
      ? e.is_datetime
        ? `${AGENDA_DAY_FMT.format(when)} · ${time}`
        : AGENDA_DAY_FMT.format(when)
      : e.is_datetime
        ? time
        : 'all day';
    if (course) meta += ` · ${course}`;

    sections.get(sectionKey)!.items.push({
      key: String(e.id),
      title: e.title,
      meta,
      spine: agendaSpine(e.kind, e.source),
    });
  }

  // Always anchor with a Today section, even when nothing's scheduled — an
  // empty "nothing on" Today orients you rather than vanishing.
  if (!sections.has(todayKey)) {
    sections.set(todayKey, {
      key: todayKey,
      label: `Today · ${AGENDA_DAY_FMT.format(now)}`,
      isToday: true,
      items: [],
    });
  }

  // Near days in chronological order, then the Later bucket last.
  const result: AgendaSection[] = [];
  for (const k of nearKeys) if (sections.has(k)) result.push(sections.get(k)!);
  if (sections.has('later')) result.push(sections.get('later')!);
  return result;
}

// ── Front Room chat feed — day dividers + per-cluster times ─────────────────
// Display-only orientation for the conversation: a day divider between Perth
// days and one muted time at the head of each speaker-cluster. Same Perth-day
// discipline as the agenda above (DAY_KEY_FMT buckets, AGENDA_TIME_FMT renders
// 24h Perth) — reused, not reinvented, because the timezone trap is identical:
// an ~11pm-Perth message is ~15:00 UTC, so anything but a Perth bucket lands the
// divider on the wrong day. The stored/sent text is untouched.
const FEED_DATE_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: PERTH_TZ,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
}); // → "Sunday 14 June"

// Same-speaker messages within this gap share one cluster head time; a wider gap
// (or a speaker change, or a new day) starts a fresh cluster.
const FEED_CLUSTER_GAP_MS = 5 * 60 * 1000;

type FeedItem =
  | { kind: 'divider'; key: string; label: string }
  | { kind: 'message'; key: string; msg: Message; time: string | null };

// A Date from an ISO string, or null if it's missing/unparseable — the guard
// that keeps a timestamp-less message from ever rendering "Invalid Date".
function parseTs(ts?: string): Date | null {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

function feedDividerLabel(dayKey: string, when: Date, now: Date): string {
  if (dayKey === DAY_KEY_FMT.format(now)) return 'Today';
  if (dayKey === DAY_KEY_FMT.format(new Date(now.getTime() - DAY_MS))) return 'Yesterday';
  return FEED_DATE_FMT.format(when);
}

// Interleave day dividers and cluster-head times through the message list, all
// in Perth. A divider precedes the first message of each Perth day (so the very
// first message gets one too); a time shows at the head of each cluster — a run
// of same-speaker messages within FEED_CLUSTER_GAP_MS, also broken by a day
// change. A message with no parseable timestamp renders bare and leaves the run
// untouched, so a just-sent bubble never blanks the feed or shows "Invalid Date".
function buildFeed(messages: Message[], now: Date): FeedItem[] {
  const items: FeedItem[] = [];
  let prevDayKey: string | null = null;
  let prevFrom: string | null = null;
  let prevAt: number | null = null;

  for (const msg of messages) {
    const when = parseTs(msg.created_at);
    if (!when) {
      items.push({ kind: 'message', key: String(msg.id), msg, time: null });
      continue;
    }

    const at = when.getTime();
    const dayKey = DAY_KEY_FMT.format(when);
    const newDay = dayKey !== prevDayKey;
    if (newDay) {
      items.push({
        kind: 'divider',
        key: `div-${dayKey}`,
        label: feedDividerLabel(dayKey, when, now),
      });
    }

    const headOfCluster =
      newDay ||
      msg.from !== prevFrom ||
      prevAt === null ||
      at - prevAt > FEED_CLUSTER_GAP_MS;

    items.push({
      kind: 'message',
      key: String(msg.id),
      msg,
      time: headOfCluster ? AGENDA_TIME_FMT.format(when) : null,
    });

    prevDayKey = dayKey;
    prevFrom = msg.from;
    prevAt = at;
  }

  return items;
}

// ── Workshop projects ───────────────────────────────────────────────────────
// One project from /api/projects — a live, read-only row off EV25 - Projects.
// The backend stays a thin data route; sorting and the status→pill mapping live
// here, where the colour system and order can move together.
type Project = {
  id: string;
  project: string;
  status: string | null;
  priority: string | null;
  category: string[];
  target: string | null;
  completion_date: string | null;
  url: string;
};

// The five live Status values in display order: the active and the stuck float
// up, the finished sinks. One array — reorder here if Blocked should ever top In
// progress (the brief flags that as a likely future tweak). Anything
// unrecognised sorts to the end rather than vanishing.
const PROJECT_STATUS_ORDER = [
  'In progress',
  'Blocked',
  'Not started',
  'Parked',
  'Done',
];

// Priority order within a status — High before Medium before Low.
const PROJECT_PRIORITY_ORDER = ['High', 'Medium', 'Low'];

// Status → pill-colour class. Elle-confirmed mapping: bronze for the live work,
// teal for queued, red for blocked (it earns the alarm colour), muted grey for
// parked, sage for done. An unknown status falls back to muted.
function projectPill(status: string | null): string {
  switch (status) {
    case 'In progress':
      return 'pill--bronze';
    case 'Not started':
      return 'pill--teal';
    case 'Blocked':
      return 'pill--red';
    case 'Parked':
      return 'pill--muted';
    case 'Done':
      return 'pill--sage';
    default:
      return 'pill--muted';
  }
}

// Sort by status (the order above), then Priority (High→Low) within a status.
// Unknown values sort to the end of their bracket. Pure — returns a new array.
function sortProjects(projects: Project[]): Project[] {
  const rank = (value: string | null, order: string[]) => {
    const i = order.indexOf(value ?? '');
    return i === -1 ? order.length : i;
  };
  return [...projects].sort(
    (a, b) =>
      rank(a.status, PROJECT_STATUS_ORDER) - rank(b.status, PROJECT_STATUS_ORDER) ||
      rank(a.priority, PROJECT_PRIORITY_ORDER) - rank(b.priority, PROJECT_PRIORITY_ORDER),
  );
}

const PROJECT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// "2026-06-30" → "30 Jun". Date-only and timezone-agnostic on purpose: we never
// build a Date from it, so the day can't drift under the browser's zone. Returns
// '' for a null or malformed date, so a project with no target renders cleanly.
function projectDate(date: string | null): string {
  if (!date) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return '';
  const month = PROJECT_MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month}` : '';
}

// The quiet secondary line: category tags, then priority, then the target date
// if set. All quiet text — the pill carries the colour, this carries the detail.
function projectMeta(p: Project): string {
  const parts: string[] = [];
  if (p.category.length) parts.push(p.category.join(', '));
  if (p.priority) parts.push(p.priority);
  const target = projectDate(p.target);
  if (target) parts.push(`→ ${target}`);
  return parts.join(' · ');
}

// ── Workshop Notion finder ──────────────────────────────────────────────────
// One result from /api/notion — a page across the cathedral, tagged with the
// area it lives in (resolved server-side by an ancestry walk) so the row can be
// spined by area. Same live-read shape as Projects, plus search and deep-link.
type NotionArea = 'journal' | 'jayhq' | 'project-child' | 'other-ev25' | 'else';
type NotionResult = {
  id: string;
  title: string;
  url: string;
  last_edited_time: string;
  area: NotionArea;
  breadcrumb: string | null;
};

// Area → spine-colour class. Elle-confirmed precedence palette: sage Journal,
// bronze Jay HQ, amber project docs, teal other-EV25, muted everything else.
// (Amber was chosen over the trial info-blue on sight — blue sat too close to
// the teal at 3px.)
function notionSpine(area: NotionArea): string {
  switch (area) {
    case 'journal':
      return 'notion__spine--sage';
    case 'jayhq':
      return 'notion__spine--bronze';
    case 'project-child':
      return 'notion__spine--amber';
    case 'other-ev25':
      return 'notion__spine--teal';
    default:
      return 'notion__spine--muted';
  }
}

// "2h ago" — a compact relative last-edited time. Stays relative all the way up
// (a finder wants "how recent", not a calendar date); coarsens as it ages.
function relativeTime(iso: string, now: number): string {
  const sec = Math.round((now - new Date(iso).getTime()) / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.round(day / 7);
  if (wk < 5) return `${wk}w ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(day / 365)}y ago`;
}

// ── Workshop generic parent blocks ──────────────────────────────────────────
// Panel-built blocks (18 Jul brief): defs from /api/workshop/blocks, tiles
// from /api/workshop/block?name=. One renderer for every block: accent spine
// coloured by the tile's SOURCE, title, then the chosen properties — chips in
// Notion's own option colour, dates as quiet text, unsupported types as an
// honest "—". Read-only, human-eyes-only: no writes, no brain tool.
type WorkshopBlockDef = { name: string; icon: string; accents: Record<string, string> };
type TileChip = { label: string; color: string };
type TileProp =
  | { name: string; kind: 'date'; value: string | null }
  | { name: string; kind: 'chips'; chips: TileChip[] }
  | { name: string; kind: 'dash' };
type BlockTile = { id: string; url: string; title: string; source: string; props: TileProp[] };

// A tile's spine class from its source's configured VDS accent. An accent the
// CSS doesn't know (shouldn't happen — the validator gates the set) falls to
// muted rather than an unstyled bar.
const WTILE_ACCENTS = new Set(['teal', 'bronze', 'sage', 'amber', 'red', 'muted']);
function wtileSpine(def: WorkshopBlockDef | undefined, source: string): string {
  const accent = def?.accents[source] ?? 'muted';
  return `wtile__spine--${WTILE_ACCENTS.has(accent) ? accent : 'muted'}`;
}

// (Workshop Mail helpers retired — the Post Box owns Gmail now.)

// ── Voice notes — the compact in-bubble player ───────────────────────────────
// Streams from the session-gated /api/voice/{key} route (never a public URL).
// Custom controls in Vale Design System styling — no native <audio controls>
// chrome. The audio element is created lazily on first interaction and kept
// off-DOM; playback continuing with the screen off is desired PWA behaviour
// (the element keeps playing while the page is hidden — verified honestly on
// device, not assumed).

// "1:07" — a compact m:ss for the player's time label.
function voiceTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// One voice note plays at a time: starting one pauses whichever was playing.
let activeVoiceAudio: HTMLAudioElement | null = null;

function VoicePlayer({ voiceKey, autoPlay }: { voiceKey: string; autoPlay?: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // Lazily build the audio element, wired to keep this player's state true.
  // preload="metadata" fetches just enough for the duration label without
  // pulling the whole clip before Elle ever taps play.
  const ensureAudio = useCallback((): HTMLAudioElement => {
    if (audioRef.current) return audioRef.current;
    const audio = new Audio(apiUrl(`/voice/${voiceKey}`));
    audio.preload = 'metadata';
    audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(audio.duration)) setDuration(audio.duration);
    });
    audio.addEventListener('timeupdate', () => setElapsed(audio.currentTime));
    audio.addEventListener('play', () => {
      if (activeVoiceAudio && activeVoiceAudio !== audio) activeVoiceAudio.pause();
      activeVoiceAudio = audio;
      setPlaying(true);
    });
    audio.addEventListener('pause', () => setPlaying(false));
    audio.addEventListener('ended', () => {
      setPlaying(false);
      setElapsed(0);
      audio.currentTime = 0;
    });
    audioRef.current = audio;
    return audio;
  }, [voiceKey]);

  // A just-rendered "Say this" performance plays immediately — she asked for
  // it out loud. Restored notes render quietly and wait for a tap.
  useEffect(() => {
    if (autoPlay) ensureAudio().play().catch(() => {});
    const audio = audioRef.current;
    return () => audio?.pause();
    // Mount-only by design: autoPlay describes the moment of first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle() {
    const audio = ensureAudio();
    if (audio.paused) audio.play().catch((err) => console.error('Voice playback failed:', err));
    else audio.pause();
  }

  // Tap the track to seek. Only meaningful once the duration is known.
  function seek(e: React.MouseEvent<HTMLDivElement>) {
    const audio = ensureAudio();
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || !duration) return;
    const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    audio.currentTime = ratio * duration;
    setElapsed(audio.currentTime);
  }

  const progress = duration ? Math.min(elapsed / duration, 1) : 0;
  return (
    <div className="voice">
      <button
        className="voice__btn"
        aria-label={playing ? 'Pause voice note' : 'Play voice note'}
        onClick={toggle}
      >
        <i className={`ti ${playing ? 'ti-player-pause' : 'ti-player-play'}`} aria-hidden="true" />
      </button>
      <div className="voice__track" ref={trackRef} onClick={seek}>
        <div className="voice__fill" style={{ width: `${progress * 100}%` }} />
      </div>
      <span className="voice__time">
        {playing || elapsed > 0
          ? voiceTime(elapsed)
          : duration !== null
            ? voiceTime(duration)
            : '·:··'}
      </span>
    </div>
  );
}

function App() {
  const [ambientOpen, setAmbientOpen] = useState(true);
  const [moodIndex, setMoodIndex] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // First-run state (Haven fork): 'checking' until /api/setup/status answers,
  // 'required' renders the wizard instead of the house. Our install answers
  // false without a DB read, so this settles instantly.
  const [setupState, setSetupState] = useState<'checking' | 'required' | 'ready'>('checking');
  // The house's names — last-good from storage for first paint, reconciled
  // from /api/identity on load. Every label below resolves through this.
  const [identity, setIdentity] = useState<Identity>(storedIdentity);
  // Which capabilities the install holds, for the rooms' honest empty states.
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  // Cron-worker health for the quiet drawer-footer line (Wave 3C surface).
  const [syncHealth, setSyncHealth] = useState<
    { worker: string; ok: boolean; last_ok_at: string | null }[] | null
  >(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [rooms, setRooms] = useState<Room[]>([]);
  // Which room is showing. Only Front Room and Workshop are live; both views
  // stay mounted (see the stage below), so switching never tears down the
  // other room's state — the Phase 3 promise: Front Room's conversation
  // survives a trip to the Workshop and back.
  const [activeRoom, setActiveRoom] = useState('front_room');
  // The Workshop's open tool, or null for the card stack. Kept in app state so
  // it persists across room switches rather than resetting on re-entry.
  const [activeTool, setActiveTool] = useState<string | null>(null);
  // The next upcoming event for the ambient "next" tile; null until loaded or
  // when nothing's coming up.
  const [nextEvent, setNextEvent] = useState<CalEvent | null>(null);
  // Current conditions for the ambient weather tile. null until the first fetch
  // lands; `place` is null when no name resolved (the temp + condition still
  // show). Kept as last-good across a failed refresh — never blanked.
  const [weather, setWeather] = useState<{
    temp: number;
    condition: string;
    place: string | null;
  } | null>(null);
  // The ambient "playing" tile — Spotify's current track. null until the first
  // fetch lands; kept as last-good across a failed refresh — never blanked.
  // track === null with a loaded state means genuinely idle (nothing playing),
  // which renders quietly, not as an error.
  const [nowPlaying, setNowPlaying] = useState<{
    playing: boolean;
    track: string | null;
    artist: string | null;
  } | null>(null);
  // The Workshop calendar tool's agenda. null = loading; agendaError tells a
  // failed fetch apart from a genuinely empty calendar.
  const [agendaEvents, setAgendaEvents] = useState<AgendaEvent[] | null>(null);
  const [agendaError, setAgendaError] = useState(false);
  // The Workshop projects tool's list. null = loading; projectsError tells a
  // failed fetch apart from a genuinely empty tracker.
  const [projectsList, setProjectsList] = useState<Project[] | null>(null);
  const [projectsError, setProjectsError] = useState(false);
  // The Workshop Notion finder. The recent list (drives the default body and the
  // card subtitle) is separate from the per-query search results, so a search
  // never clobbers the recent glance. null = loading; the *Error flags tell a
  // failed fetch apart from a genuinely empty result.
  const [notionRecent, setNotionRecent] = useState<NotionResult[] | null>(null);
  const [notionError, setNotionError] = useState(false);
  const [notionQuery, setNotionQuery] = useState('');
  const [notionResults, setNotionResults] = useState<NotionResult[] | null>(null);
  const [notionSearchError, setNotionSearchError] = useState(false);
  // Generic parent blocks (18 Jul) — panel-built blocks that join the tool
  // bar beside the bespoke three. Defs (name/icon/accents) load with the
  // room; each block's tiles load when it's opened. null = not loaded yet.
  const [wsBlockDefs, setWsBlockDefs] = useState<WorkshopBlockDef[] | null>(null);
  const [blockTiles, setBlockTiles] = useState<Record<string, BlockTile[]>>({});
  const [blockErrors, setBlockErrors] = useState<Record<string, boolean>>({});
  const [thinking, setThinking] = useState(false);
  // The tool-round status from the reply stream: while the brain is off looking
  // something up, the "…" placeholder reads "(looking that up…)" instead.
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  // "Say this" — the on-demand voice render of an existing Jay message. One
  // render in flight at a time (it's an ElevenLabs call, not a toggle);
  // justSaidId marks the message whose fresh player should autoplay — she
  // asked to hear it, so it speaks. sayErrorId flashes an honest, transient
  // failure note under the message that couldn't render.
  const [sayingId, setSayingId] = useState<string | null>(null);
  const [sayErrorId, setSayErrorId] = useState<string | null>(null);
  const [justSaidId, setJustSaidId] = useState<string | null>(null);
  // Mirror of `thinking` for the history reconcile, which runs from an event
  // listener and needs the live value: while a send is in flight it must not
  // clobber the optimistic bubbles with server rows.
  const thinkingRef = useRef(false);
  useEffect(() => {
    thinkingRef.current = thinking;
  }, [thinking]);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [installEvent, setInstallEvent] =
    useState<BeforeInstallPromptEvent | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const convoEndRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view — when one is appended (Elle's or
  // Jay's), not while the composer grows, so typing never yanks the scroll.
  useEffect(() => {
    convoEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, thinking]);

  // Grow the composer to fit its content, capped at COMPOSER_MAX_HEIGHT.
  function autosizeComposer() {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }

  // The light switch (Décor circuit, Haven-ready): the worn MODE is device
  // dressing — this device's localStorage, never a row. The boot script
  // already applied it before first paint; this state just keeps the drawer
  // switch honest about which way it points.
  const [decorMode, setDecorModeState] = useState<DecorMode>(getDecorMode);
  const toggleDecorMode = () => {
    const next: DecorMode = decorMode === 'light' ? 'dark' : 'light';
    setDecorMode(next);
    setDecorModeState(next);
  };

  // The Décor runtime: confirm the worn theme on load (the shell already
  // painted from the Worker's injection or the last-good copy — this is the
  // reconcile, not the first paint), re-check on return to a visible tab
  // (60s throttle, the house's uniform cadence), and re-dress immediately
  // when the Fuse Box announces a panel-side change.
  useEffect(() => {
    let lastFetch = Date.now();
    void refreshDecor();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastFetch > 60_000) {
        lastFetch = Date.now();
        void refreshDecor();
      }
    };
    const onChanged = () => {
      lastFetch = Date.now();
      void refreshDecor();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(DECOR_CHANGED_EVENT, onChanged);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(DECOR_CHANGED_EVENT, onChanged);
    };
  }, []);

  // Track connectivity for the offline state. The service worker serves the
  // cached shell offline; this is what tells Elle that Jay isn't reachable.
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // Install affordance: stash Chromium's beforeinstallprompt so we can offer
  // it in our own UI. Never shown once installed (standalone) or after Elle
  // has dismissed it. iOS never fires this — it goes via Share → Add to Home
  // Screen, covered by the meta tags in index.html.
  useEffect(() => {
    if (
      window.matchMedia('(display-mode: standalone)').matches ||
      localStorage.getItem(INSTALL_DISMISSED_KEY)
    ) {
      return;
    }
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setInstallEvent(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  async function install() {
    if (!installEvent) return;
    await installEvent.prompt();
    await installEvent.userChoice; // either way, the event is spent
    setInstallEvent(null);
  }

  function dismissInstall() {
    localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
    setInstallEvent(null);
  }

  // Advance the mood tile and persist the new value so Jay reads it. Best-effort
  // — a failed write leaves the tile where it is locally; it'll reconcile on the
  // next load. Tapping is how Elle tells Jay which Jay to be.
  // moodTouchedAt guards the ambient poll below: a tick already in flight when
  // Elle taps would carry the pre-tap mood, so server reads inside the guard
  // window are ignored (the POST + the next tick reconcile).
  const moodTouchedAt = useRef(0);
  function cycleMood() {
    const next = (moodIndex + 1) % MOODS.length;
    setMoodIndex(next);
    moodTouchedAt.current = Date.now();
    api(`/mood`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mood: MOOD_IDS[next] }),
    }).catch((err) => console.error('Failed to set mood:', err));
  }

  // Run once when the app loads: fetch the room catalogue from the backend.
  // Array-guarded: on a virgin install this API answers 403 (setup first),
  // and an undefined catalogue must never reach render.
  useEffect(() => {
    api(`/rooms`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data?.rooms)) setRooms(data.rooms);
      })
      .catch((err) => console.error('Failed to load rooms:', err));
  }, []);

  // First-run check (Haven fork): a virgin install renders the wizard instead
  // of the house. Answers pre-gate; a failed check assumes a configured house
  // (the gate will still do its job).
  useEffect(() => {
    api(`/setup/status`)
      .then((res) => res.json())
      .then((data) => setSetupState(data?.setup_required ? 'required' : 'ready'))
      .catch(() => setSetupState('ready'));
  }, []);

  // The names + capability truth, once at boot — and again whenever the Fuse
  // Box saves the profile, so a rename follows everywhere with no reload.
  useEffect(() => {
    const loadIdentityProfile = () =>
      void fetchIdentity().then((profile) => {
        if (profile) setIdentity(profile);
      });
    loadIdentityProfile();
    api(`/readiness`)
      .then((res) => res.json())
      .then((data) => {
        if (data?.ok && data.readiness) setReadiness(data.readiness as Readiness);
      })
      .catch(() => {
        /* stays null — rooms render without gating */
      });
    window.addEventListener(IDENTITY_CHANGED_EVENT, loadIdentityProfile);
    return () => window.removeEventListener(IDENTITY_CHANGED_EVENT, loadIdentityProfile);
  }, []);

  // The Fuse Box is desktop-only (v0.3 brief): long-form curation on a phone
  // is hostile. `lg` = 1024px. Ergonomics, NOT security — the lock is the
  // server-side side gate; this just decides whether the panel renders.
  const [isDesktop, setIsDesktop] = useState(
    () => window.matchMedia('(min-width: 1024px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => setIsDesktop(mq.matches);
    mq.addEventListener('change', sync);
    // Some embedded webviews resize the viewport without dispatching
    // matchMedia change events; a plain resize listener catches those.
    window.addEventListener('resize', sync);
    return () => {
      mq.removeEventListener('change', sync);
      window.removeEventListener('resize', sync);
    };
  }, []);
  // Shrinking below lg while in the Fuse Box bounces to the Front Room —
  // the panel unmounts, never lingers half-rendered on a phone.
  useEffect(() => {
    if (!isDesktop && activeRoom === 'fusebox') setActiveRoom('front_room');
  }, [isDesktop, activeRoom]);

  // Deep-link: a mail-notification tap opens /?room=post_box — land there on
  // load so clicking a push drops Elle straight into the Post Box.
  useEffect(() => {
    const room = new URLSearchParams(window.location.search).get('room');
    if (room === 'post_box' || room === 'hearth' || room === 'listening_room' || room === 'gallery') {
      setActiveRoom(room);
    }
    // The Fuse Box deep-link honours the desktop gate: below lg it's refused,
    // landing on the Front Room like any unknown ?room value.
    if (room === 'fusebox' && window.matchMedia('(min-width: 1024px)').matches) {
      setActiveRoom(room);
    }
  }, []);

  // The thread is server-owned: restore it on load AND on every foreground, so
  // picking up the phone after chatting on the desktop simply shows the thread.
  // The reconcile replaces the local thread with the server's (dropping any
  // local-only error bubble), but stands down while a send is in flight so it
  // can't clobber the optimistic bubbles mid-exchange.
  useEffect(() => {
    let cancelled = false;
    const reconcile = () => {
      if (thinkingRef.current) return;
      api('/history?limit=200')
        .then((res) => res.json())
        .then((data) => {
          if (cancelled || !data.ok || !Array.isArray(data.messages)) return;
          setMessages(data.messages);
        })
        .catch((err) => console.error('Failed to load history:', err));
    };
    reconcile();
    const onVis = () => document.visibilityState === 'visible' && reconcile();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // (Mood's load-and-foreground refetch now rides the single ambient poll below.)

  // Cron-worker health for the drawer footer — load on mount + foreground.
  useEffect(() => {
    const load = () => {
      api('/sync-health')
        .then((r) => r.json())
        .then((d) => {
          if (d.ok && Array.isArray(d.health)) setSyncHealth(d.health);
        })
        .catch(() => {});
    };
    load();
    const onVis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // ── The ambient bar, one wake per tick ──────────────────────────────────────
  // One 30s useVisiblePoll against GET /api/ambient replaces the four separate
  // fetch loops the tiles used to run (next 5m / weather 15m / spotify 30s /
  // mood on-load+foreground). The Worker's per-source caches make the fast
  // cadence free for the slow sources, and the phone radio wakes ONCE per tick
  // instead of three times. Fields are per-source null on failure, so every tile
  // keeps its own last-good rather than one dead upstream blanking the bar.
  // Device GPS + client-side place naming keep their old semantics: the fix is
  // reused within its maximumAge, and the place NAME is cached hard by rounded
  // coords (fair-use: stored coords are never replayed into the geocoder).
  const ambientPoll = useCallback(async () => {
    try {
      const fix = await getDeviceFix();
      const coords = fix ? `?lat=${fix.coords.latitude}&lon=${fix.coords.longitude}` : '';
      const [res, place] = await Promise.all([
        api(`/ambient${coords}`).then((r) => r.json()),
        fix
          ? placeNameFor(fix.coords.latitude, fix.coords.longitude).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (!res.ok) return false;

      // next is wrapped ({ event }) so null can mean "calendar read failed this
      // tick, keep last-good" while { event: null } means "genuinely nothing
      // coming up, clear the tile" — the old route's distinction, preserved.
      if (res.next) setNextEvent(res.next.event ?? null);

      if (res.weather) {
        setWeather((prev) => ({
          temp: res.weather.temp,
          condition: res.weather.condition,
          // Device path: the precise client-side name wins. IP path: the Worker's
          // coarse cf place. Either way a miss keeps the last-good label.
          place: place ?? res.weather.place ?? prev?.place ?? null,
        }));
      }

      if (res.nowPlaying) setNowPlaying(res.nowPlaying);

      // Mood rides along — but never clobbers a tap (see moodTouchedAt above).
      if (res.mood && Date.now() - moodTouchedAt.current > 10_000) {
        const i = MOOD_IDS.indexOf(res.mood);
        if (i >= 0) setMoodIndex(i);
      }
      return true;
    } catch (err) {
      // Last-good stays everywhere — a failed tick never blanks a tile.
      console.error('Failed to load ambient bar:', err);
      return false;
    }
  }, []);
  useVisiblePoll(ambientPoll, 30_000, true);

  // Load the Workshop calendar agenda when its tool is open, and refresh it when
  // the app returns to the foreground. Best-effort, same discipline as the
  // ambient tile: a failed refresh keeps the last-good agenda rather than
  // blanking it. Only fetches while the Calendar tool is actually showing.
  const calendarToolOpen = activeRoom === 'workshop' && activeTool === 'Calendar';
  useEffect(() => {
    if (!calendarToolOpen) return;
    let cancelled = false;
    function load() {
      api(`/calendar/agenda`)
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return;
          if (data.ok && Array.isArray(data.events)) {
            setAgendaEvents(data.events);
            setAgendaError(false);
          } else {
            setAgendaError(true);
          }
        })
        .catch((err) => {
          if (cancelled) return;
          console.error('Failed to load agenda:', err);
          setAgendaError(true);
        });
    }
    load();
    function refreshIfVisible() {
      if (document.visibilityState === 'visible') load();
    }
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [calendarToolOpen]);

  // Group the agenda into Perth-day sections for render.
  const agendaSections = useMemo(
    () => groupAgenda(agendaEvents ?? [], new Date()),
    [agendaEvents],
  );

  // Interleave day dividers + cluster times through the chat feed for render.
  // Recomputed when the thread changes — same shape as the agenda memo above.
  const feedItems = useMemo(() => buildFeed(messages, new Date()), [messages]);

  // Load the Workshop projects whenever the Workshop is open — the tool body
  // and the Projects card front both want them, so we fetch on entering the room
  // rather than only on opening the tool. The ~60s cache keeps re-entries off
  // Notion. Refreshes on return to the foreground; same discipline as the
  // agenda — a failed refresh keeps the last-good list rather than blanking it.
  const workshopOpen = activeRoom === 'workshop';
  useEffect(() => {
    if (!workshopOpen) return;
    let cancelled = false;
    function load() {
      api(`/projects`)
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return;
          if (data.ok && Array.isArray(data.projects)) {
            setProjectsList(data.projects);
            setProjectsError(false);
          } else {
            setProjectsError(true);
          }
        })
        .catch((err) => {
          if (cancelled) return;
          console.error('Failed to load projects:', err);
          setProjectsError(true);
        });
    }
    load();
    function refreshIfVisible() {
      if (document.visibilityState === 'visible') load();
    }
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [workshopOpen]);

  // Sorted for render: active and blocked up top, done dimmed at the bottom.
  const sortedProjects = useMemo(
    () => sortProjects(projectsList ?? []),
    [projectsList],
  );
  // The in-progress projects, for the Projects card front — real data, no
  // invented number. null list until the first load, so the card shows a
  // neutral label until there's something true to say.
  const inProgressProjects = useMemo(
    () => (projectsList ?? []).filter((p) => p.status === 'In progress'),
    [projectsList],
  );

  // Load the Notion recent list whenever the Workshop is open — it's the tool's
  // default body and the Notion card's subtitle, so (like Projects) it loads on
  // entering the room, not only on opening the tool. ~60s cache covers
  // re-entries; last-good kept on a failed refresh.
  useEffect(() => {
    if (!workshopOpen) return;
    let cancelled = false;
    function load() {
      api(`/notion`)
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return;
          if (data.ok && Array.isArray(data.results)) {
            setNotionRecent(data.results);
            setNotionError(false);
          } else {
            setNotionError(true);
          }
        })
        .catch((err) => {
          if (cancelled) return;
          console.error('Failed to load recent Notion:', err);
          setNotionError(true);
        });
    }
    load();
    function refreshIfVisible() {
      if (document.visibilityState === 'visible') load();
    }
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [workshopOpen]);

  // Load the generic block defs whenever the Workshop is open — they draw the
  // panel-built tool cards beside the bespoke three. Same room-entry +
  // foreground-refresh discipline as Projects; a failed refresh keeps the
  // last-good defs rather than dropping cards from the bar.
  useEffect(() => {
    if (!workshopOpen) return;
    let cancelled = false;
    function load() {
      api(`/workshop/blocks`)
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return;
          if (data.ok && Array.isArray(data.blocks)) setWsBlockDefs(data.blocks);
        })
        .catch((err) => console.error('Failed to load workshop blocks:', err));
    }
    load();
    function refreshIfVisible() {
      if (document.visibilityState === 'visible') load();
    }
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [workshopOpen]);

  // Load an open generic block's tiles. The server merges + sorts behind a
  // ~60s cache with last-good, so this stays a thin fetch; a failed refresh
  // keeps the last-good list (blockErrors only styles the never-loaded state).
  const genericBlockOpen =
    workshopOpen && activeTool !== null && (wsBlockDefs ?? []).some((b) => b.name === activeTool)
      ? activeTool
      : null;
  useEffect(() => {
    if (!genericBlockOpen) return;
    const name = genericBlockOpen;
    let cancelled = false;
    function load() {
      api(`/workshop/block?name=${encodeURIComponent(name)}`)
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return;
          if (data.ok && Array.isArray(data.tiles)) {
            setBlockTiles((t) => ({ ...t, [name]: data.tiles }));
            setBlockErrors((e) => ({ ...e, [name]: false }));
          } else {
            setBlockErrors((e) => ({ ...e, [name]: true }));
          }
        })
        .catch((err) => {
          if (cancelled) return;
          console.error('Failed to load block tiles:', err);
          setBlockErrors((e) => ({ ...e, [name]: true }));
        });
    }
    load();
    function refreshIfVisible() {
      if (document.visibilityState === 'visible') load();
    }
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [genericBlockOpen]);

  // The tool bar: the bespoke three plus every panel-built block, in config
  // order. A generic card's sub names its source count — real data, no
  // invented number, same honesty rule as the bespoke subs.
  // Degradation (Haven): the Notion-backed bespoke tools (Notion finder,
  // Projects) go dormant — absent, not erroring — until the Notion key and the
  // workshop mappings exist. Calendar stays: it reads the mirror table, no key.
  const notionToolsReady =
    readiness === null || (readiness.notion && readiness.workshop_mappings);
  const allWorkshopTools = [
    ...WORKSHOP_TOOLS.filter(
      (t) => notionToolsReady || (t.name !== 'Notion' && t.name !== 'Projects'),
    ),
    ...(wsBlockDefs ?? []).map((b) => {
      const n = Object.keys(b.accents).length;
      return { name: b.name, icon: b.icon, sub: `${n} source${n === 1 ? '' : 's'}` };
    }),
  ];

  // Search the cathedral as Elle types — debounced, and only while the Notion
  // tool is open. An empty query clears back to the recent list rather than
  // firing a search. Search is uncached server-side; the debounce keeps it from
  // hammering the route on every keystroke.
  const notionToolOpen = activeRoom === 'workshop' && activeTool === 'Notion';
  useEffect(() => {
    if (!notionToolOpen) return;
    const q = notionQuery.trim();
    if (!q) {
      setNotionResults(null);
      setNotionSearchError(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api(`/notion?q=${encodeURIComponent(q)}`)
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return;
          if (data.ok && Array.isArray(data.results)) {
            setNotionResults(data.results);
            setNotionSearchError(false);
          } else {
            setNotionSearchError(true);
          }
        })
        .catch((err) => {
          if (cancelled) return;
          console.error('Failed to search Notion:', err);
          setNotionSearchError(true);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [notionToolOpen, notionQuery]);

  // Which Notion list the body shows: search results when there's a query, the
  // recent list otherwise — with the matching error flag.
  const notionIsSearch = notionQuery.trim() !== '';
  const notionList = notionIsSearch ? notionResults : notionRecent;
  const notionListFailed = notionIsSearch ? notionSearchError : notionError;


  // "Say this": render an existing Jay message through the voice pipeline (no
  // brain involvement) and attach the audio to that message. Idempotent both
  // ends — the affordance only shows on messages without audio, and the server
  // returns the stored attachment rather than re-rendering if asked twice.
  // Only server-persisted messages qualify (string ids): a just-streamed bubble
  // gets its server id from the post-exchange reconcile moments later.
  async function sayThis(id: string) {
    if (sayingId) return;
    setSayingId(id);
    setSayErrorId(null);
    try {
      const res = await api('/voice/say', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_id: id }),
      });
      const data = await res.json();
      if (data.ok && data.voice?.key) {
        setJustSaidId(id);
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, voice: { key: data.voice.key } } : m)),
        );
        return;
      }
      throw new Error(data.error ?? 'render failed');
    } catch (err) {
      // Honest and quiet: a small transient note on the message, no fake audio.
      console.error('Say-this failed:', err);
      setSayErrorId(id);
      setTimeout(() => setSayErrorId((cur) => (cur === id ? null : cur)), 4000);
    } finally {
      setSayingId(null);
    }
  }

  async function send() {
    const text = input.trim();
    // Ignore empty sends, double-sends, and offline sends — no fake replies.
    if (!text || thinking || !navigator.onLine) return;
    // Both bubble ids are captured HERE, synchronously — never inside a state
    // updater. React flushes updaters later, so a Date.now() inside one can land
    // a millisecond after a Date.now() outside it and collide with jayId.
    const elleId = Date.now();
    const jayId = elleId + 1;
    // Optimistic Elle bubble. The server owns the thread now, so we send only the
    // new message — never the history — and reconcile against what comes back.
    setMessages((prev) => [
      ...prev,
      { id: elleId, from: 'elle', text, created_at: new Date().toISOString() },
    ]);
    setInput('');
    // Collapse the composer back to a single line for the next message.
    if (composerRef.current) composerRef.current.style.height = 'auto';
    setThinking(true);
    setToolStatus(null);
    // Jay's reply is typed into one bubble. Deltas arrive in BURSTS (the API
    // sends a few words at a time, and several bursts can share one network
    // packet), which reads as jumpy — so incoming text lands in `pending` and a
    // steady 35ms drain feeds the bubble a few characters per tick, taking
    // proportionally bigger bites when a backlog builds so the typing never falls
    // far behind the live reply.
    // `received` = any text has arrived; `started` = the bubble is on screen.
    let pending = '';
    let shown = '';
    let received = false;
    let started = false;
    let drainTimer: number | null = null;
    const renderShown = () => {
      // The placeholder ("…" / "(looking that up…)") yields the moment text draws.
      setThinking(false);
      setToolStatus(null);
      if (!started) {
        started = true;
        setMessages((prev) => [
          ...prev,
          { id: jayId, from: 'jay', text: shown, created_at: new Date().toISOString() },
        ]);
      } else {
        setMessages((prev) => prev.map((m) => (m.id === jayId ? { ...m, text: shown } : m)));
      }
    };
    const drainTick = () => {
      if (!pending) {
        if (drainTimer !== null) {
          clearInterval(drainTimer);
          drainTimer = null;
        }
        return;
      }
      // Hidden tab: browsers throttle intervals to ~1/sec, which would turn the
      // typing into a minutes-long crawl nobody is watching — dump it all instead.
      const take =
        document.visibilityState === 'hidden'
          ? pending.length
          : Math.max(2, Math.ceil(pending.length / 8));
      shown += pending.slice(0, take);
      pending = pending.slice(take);
      renderShown();
    };
    const appendText = (t: string) => {
      if (!t) return;
      received = true;
      pending += t;
      if (drainTimer === null) drainTimer = window.setInterval(drainTick, 35);
    };
    // Dump whatever's still buffered straight into the bubble — for error paths,
    // where an honest jump beats losing the tail of what actually arrived.
    const flush = () => {
      if (drainTimer !== null) {
        clearInterval(drainTimer);
        drainTimer = null;
      }
      if (pending) {
        shown += pending;
        pending = '';
        renderShown();
      }
    };
    // Resolves once the drain has typed everything out — the happy path lets the
    // typing finish naturally instead of snapping the tail in.
    const drained = () =>
      new Promise<void>((resolve) => {
        const check = () => (pending ? setTimeout(check, 40) : resolve());
        check();
      });
    // The Wave 2 local-error treatment: keep whatever partial text streamed, mark
    // the bubble local (never sent, dropped on the next history reconcile — the
    // persisted thread is the truth we reconcile back to).
    const markLocal = (fallback: string) => {
      if (started) {
        setMessages((prev) => prev.map((m) => (m.id === jayId ? { ...m, local: true } : m)));
      } else {
        setMessages((prev) => [
          ...prev,
          { id: jayId, from: 'jay', local: true, text: fallback, created_at: new Date().toISOString() },
        ]);
      }
    };

    try {
      const res = await api('/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      // Pre-stream failures (bad body, history/save errors) still come back as a
      // plain non-OK JSON response — the stream never opened.
      if (!res.ok || !res.body) {
        let errMsg = 'unknown error';
        try {
          const data = await res.json();
          errMsg = data.error ?? errMsg;
        } catch {
          /* non-JSON error body — keep the default */
        }
        markLocal(`(Couldn't reach ${identity.companion_name}: ${errMsg})`);
        return;
      }

      // Read the SSE stream. delta → append text; status → the placeholder says
      // what's happening; done → reconcile created_at; error → keep the partial.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamError: string | null = null;
      let sawDone = false;
      let doneAt: string | null = null;
      let finalReply: string | null = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const eventLine = frame.split('\n').find((l) => l.startsWith('event:'));
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!eventLine || !dataLine) continue;
          const event = eventLine.slice(6).trim();
          let data: { text?: string; label?: string; created_at?: string; reply?: string; error?: string };
          try {
            data = JSON.parse(dataLine.slice(5).trim());
          } catch {
            continue;
          }
          if (event === 'delta') {
            appendText(data.text ?? '');
          } else if (event === 'status') {
            // A tool round: the brain went quiet to look something up.
            setThinking(true);
            setToolStatus(data.label ?? 'looking that up');
          } else if (event === 'done') {
            sawDone = true;
            doneAt = data.created_at ?? null;
            if (typeof data.reply === 'string') finalReply = data.reply;
            // Safety net: a reply that produced no deltas (synthesised fallback)
            // still types out from the done event's full text. Gated on
            // `received`, not `started` — buffered-but-not-yet-drawn text counts.
            if (!received && finalReply) appendText(finalReply);
          } else if (event === 'error') {
            streamError = data.error ?? 'unknown error';
          }
        }
      }

      if (streamError) {
        // Show everything that actually arrived, then mark it local.
        flush();
        markLocal(`(Couldn't reach ${identity.companion_name}: ${streamError})`);
      } else if (sawDone) {
        // Let the typing finish naturally, then reconcile the bubble against the
        // persisted created_at — and the done event's full reply, in case any
        // delta went missing (normally identical, so this is invisible).
        await drained();
        flush();
        if (started) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === jayId
                ? { ...m, created_at: doneAt ?? m.created_at, text: finalReply ?? shown }
                : m,
            ),
          );
        }
        // The server owns the thread, and this exchange may have added MORE to
        // it than the streamed reply: a voice note lands as its own message
        // row, saved mid-exchange by the send_voice_note tool. Reconcile
        // against the persisted thread now so a voice note appears in the live
        // exchange (and so the fresh turns carry their server ids, which the
        // say-this affordance needs). One guard: if the reply's best-effort
        // save failed, the server tail won't match what streamed — keep the
        // streamed bubble on top, marked local, rather than vanishing words
        // Elle just read.
        try {
          const streamed = finalReply ?? shown;
          const hist = await api('/history?limit=200').then((r) => r.json());
          // An EMPTY thread means the server isn't owning it (the dev sandbox
          // restores nothing by design — its thread lives in the Worker's
          // memory) — reconciling against it would wipe the feed. Skip; the
          // optimistic thread is already the truth there.
          if (hist.ok && Array.isArray(hist.messages) && hist.messages.length > 0) {
            const rows = hist.messages as Message[];
            const last = rows[rows.length - 1];
            if (last && last.from === 'jay' && last.text === streamed) {
              setMessages(rows);
            } else {
              setMessages([
                ...rows,
                {
                  id: jayId,
                  from: 'jay',
                  text: streamed,
                  created_at: doneAt ?? new Date().toISOString(),
                  local: true,
                },
              ]);
            }
          }
        } catch {
          /* keep the optimistic thread — the next foreground reconcile owns it */
        }
      } else {
        // The stream ended without done or error — cut off mid-reply. Keep the
        // partial, marked local; the next history fetch shows the persisted truth.
        flush();
        markLocal(`(${identity.companion_name}'s reply was cut off — it'll be here after a refresh.)`);
      }
    } catch (err) {
      // Network drop mid-stream: same treatment — partial survives, marked local.
      console.error('Failed to reach the companion:', err);
      flush();
      markLocal(`(Couldn't reach ${identity.companion_name} just now — is the Worker running?)`);
    } finally {
      // Safety: no drain interval outlives the send, whatever path exited.
      if (drainTimer !== null) {
        clearInterval(drainTimer);
        drainTimer = null;
      }
      setThinking(false);
      setToolStatus(null);
    }
  }

  // A virgin install renders the wizard, not the house (Haven fork). Placed
  // after every hook (so the hook order never changes between modes) and
  // BEFORE any derived render state — nothing below may assume loaded data.
  if (setupState === 'required') {
    return <SetupWizard />;
  }

  // The header shows the room you're in. Fall back to sensible names before the
  // room catalogue has loaded from the backend.
  const activeRoomName =
    rooms.find((r) => r.name === activeRoom)?.display_name ??
    (activeRoom === 'workshop'
      ? 'Workshop'
      : activeRoom === 'fusebox' // frontend-owned, never in the rooms table
        ? 'The Fuse Box'
        : 'Front Room');

  // Desktop opens the Fuse Box straight from an honest empty state; a phone
  // gets pointed at a desktop instead (the panel is desktop-only by design).
  const openFuseBox = isDesktop
    ? () => {
        setActiveRoom('fusebox');
        setDrawerOpen(false);
      }
    : null;

  return (
    <IdentityContext.Provider value={identity}>
    <div className="app">
      {/* Header — hamburger + room title open the drawer; mic on the right */}
      <header className="header">
        <button
          className="header__menu"
          aria-label="Open rooms"
          onClick={() => setDrawerOpen(true)}
        >
          <i className="ti ti-menu-2" aria-hidden="true" />
          <span className="header__title">{activeRoomName}</span>
        </button>
        <i className="ti ti-microphone header__mic" aria-label="Voice" />
      </header>

      {/* Ambient bar — folds away, mood tile cycles */}
      <section className="ambient">
        <button
          className="ambient__toggle"
          onClick={() => setAmbientOpen((open) => !open)}
          aria-expanded={ambientOpen}
        >
          <span className="ambient__label">
            <i className="ti ti-broadcast" aria-hidden="true" /> Ambient
          </span>
          <i
            className={`ti ${ambientOpen ? 'ti-chevron-down' : 'ti-chevron-right'}`}
            aria-hidden="true"
          />
        </button>

        {ambientOpen && (
          <div className="ambient__body">
            <div className="tile">
              <span className="tile__label">
                <i className="ti ti-music" aria-hidden="true" /> playing
              </span>
              <span className="tile__value">
                {nowPlaying?.track
                  ? `${[nowPlaying.track, nowPlaying.artist]
                      .filter(Boolean)
                      .join(' — ')}${nowPlaying.playing ? '' : ' (paused)'}`
                  : 'Nothing playing'}
              </span>
            </div>
            <div className="tile">
              <span className="tile__label">
                <i className="ti ti-calendar" aria-hidden="true" /> next
              </span>
              <span className="tile__value tile__value--next">
                {nextEvent ? nextLabel(nextEvent, new Date()) : 'Nothing coming up'}
              </span>
            </div>
            <div className="tile">
              <span className="tile__label">
                <i className="ti ti-cloud" aria-hidden="true" /> {weather?.place ?? 'weather'}
              </span>
              <span className="tile__value">
                {weather ? `${weather.temp}° ${weather.condition}` : '—'}
              </span>
            </div>
            <button
              className="tile tile--mood"
              onClick={cycleMood}
            >
              <span className="tile__label">
                <i className="ti ti-mood-smile" aria-hidden="true" /> mood
              </span>
              <span className="tile__value tile__value--mood">
                {MOODS[moodIndex].replace('{user}', identity.user_name)}
              </span>
            </button>
          </div>
        )}
      </section>

      {/* The room stage. Both views stay mounted; only the active one shows, and
          switching plays a brief, deliberate transition (rooms are a transition,
          not a tab swap). Keeping both mounted is what preserves Front Room's
          conversation and scroll across a trip to the Workshop. */}
      <div className="stage">
        {/* ── Front Room — the conversation ──────────────────────────────── */}
        <div
          className={`room-view ${activeRoom === 'front_room' ? 'room-view--on' : ''}`}
        >
          <main className="convo">
            {feedItems.map((item) =>
              item.kind === 'divider' ? (
                <div key={item.key} className="feed-divider">
                  <span className="feed-divider__label">{item.label}</span>
                </div>
              ) : (
                <div
                  key={item.key}
                  className={`feed-msg feed-msg--${item.msg.from === 'elle' ? 'elle' : 'jay'}`}
                >
                  {item.time && <span className="feed-time">{item.time}</span>}
                  <div
                    className={`bubble ${item.msg.from === 'elle' ? 'bubble--elle' : 'bubble--jay'} ${item.msg.local ? 'bubble--local' : ''}`}
                  >
                    {/* A voice note: the player up top, the transcript (the
                        message text — the canon) beneath it. */}
                    {item.msg.voice && (
                      <VoicePlayer
                        key={item.msg.voice.key}
                        voiceKey={item.msg.voice.key}
                        autoPlay={justSaidId === item.msg.id}
                      />
                    )}
                    {/* A generated image: the picture above the intent text,
                        resolved live from the Gallery row. */}
                    {item.msg.image && (
                      <InlineImage
                        key={item.msg.image.id}
                        imageId={item.msg.image.id}
                        onOpenGallery={() => setActiveRoom('gallery')}
                      />
                    )}
                    <Markdown remarkPlugins={MD_PLUGINS} components={MD_COMPONENTS}>
                      {item.msg.text}
                    </Markdown>
                  </div>
                  {/* "Say this" — perform any of Jay's messages in his voice.
                      Only on server-persisted turns (string ids): a message
                      still waiting on its server id gets the affordance after
                      the post-exchange reconcile lands moments later. */}
                  {item.msg.from === 'jay' &&
                    !item.msg.voice &&
                    !item.msg.local &&
                    typeof item.msg.id === 'string' && (
                      <button
                        className="say-this"
                        aria-label={`Say this in ${identity.companion_name}'s voice`}
                        disabled={sayingId !== null}
                        onClick={() => sayThis(item.msg.id as string)}
                      >
                        <i
                          className={`ti ${sayingId === item.msg.id ? 'ti-loader-2 say-this__spin' : 'ti-volume'}`}
                          aria-hidden="true"
                        />
                        {sayingId === item.msg.id && <span>rendering…</span>}
                        {sayErrorId === item.msg.id && (
                          <span className="say-this__err">couldn't render — try again</span>
                        )}
                      </button>
                    )}
                </div>
              ),
            )}
            {thinking && (
              <div className="bubble bubble--jay">{toolStatus ? `(${toolStatus}…)` : '…'}</div>
            )}
            <div ref={convoEndRef} />
          </main>

          {/* Offline state — shell still renders, but the companion needs the network */}
          {!online && (
            <div className="offline" role="status">
              <i className="ti ti-wifi-off" aria-hidden="true" />
              You're offline — {identity.companion_name}'s not reachable right now
            </div>
          )}

          {/* Degradation (Haven): without the Anthropic key there is no one on
              the other end — say so honestly instead of letting a send 500. */}
          {readiness && !readiness.anthropic && (
            <RoomNeeds
              icon="ti-message-circle"
              room="The Front Room"
              needs="the Anthropic key — it's how the companion talks"
              circuit="Keys"
              onOpenFuseBox={openFuseBox}
            />
          )}

          {/* Install affordance — only when the browser offers the install event */}
          {installEvent && (
            <div className="install">
              <i className="ti ti-device-mobile-down" aria-hidden="true" />
              <span className="install__text">Keep {identity.house_name} on your home screen</span>
              <button className="install__go" onClick={install}>
                Install
              </button>
              <button
                className="install__dismiss"
                aria-label="Dismiss install prompt"
                onClick={dismissInstall}
              >
                <i className="ti ti-x" aria-hidden="true" />
              </button>
            </div>
          )}

          {/* Composer — auto-growing textarea. Enter makes a new line; the Send
              button is the only thing that sends. Elle writes in paragraphs. */}
          <div className="composer">
            <textarea
              ref={composerRef}
              className="composer__input"
              rows={1}
              placeholder={online ? `message ${identity.companion_name}…` : 'offline'}
              aria-label={`Message ${identity.companion_name}`}
              value={input}
              disabled={!online || (readiness !== null && !readiness.anthropic)}
              onChange={(e) => {
                setInput(e.target.value);
                autosizeComposer();
              }}
            />
            <button
              className="composer__send"
              aria-label="Send"
              onClick={send}
              disabled={thinking || !online || (readiness !== null && !readiness.anthropic)}
            >
              <i className="ti ti-arrow-up" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* ── Workshop — tool cards collapse into a 2×2 grid on select ────── */}
        <div
          className={`room-view ${activeRoom === 'workshop' ? 'room-view--on' : ''}`}
        >
          <div className="workshop">
            {activeTool === null ? (
              // The card stack — one full-width card per tool, bespoke and
              // panel-built alike.
              <div className="work-cards">
                {allWorkshopTools.map((tool) => (
                  <button
                    key={tool.name}
                    className="work-card"
                    onClick={() => setActiveTool(tool.name)}
                  >
                    <i
                      className={`ti ${tool.icon} work-card__icon`}
                      aria-hidden="true"
                    />
                    <span className="work-card__text">
                      <span className="work-card__name">{tool.name}</span>
                      <span className="work-card__sub">
                        {tool.name === 'Calendar'
                          ? nextEvent
                            ? nextLabel(nextEvent, new Date())
                            : 'Nothing coming up'
                          : tool.name === 'Projects'
                            ? projectsList === null
                              ? tool.sub
                              : inProgressProjects.length === 0
                                ? 'Nothing in progress'
                                : inProgressProjects
                                    .map((p) => p.project)
                                    .join(' · ')
                            : tool.name === 'Notion'
                              ? notionRecent === null
                                ? tool.sub
                                : notionRecent.length === 0
                                  ? 'Nothing recent'
                                  : notionRecent[0].title
                              : tool.sub}
                      </span>
                    </span>
                    <i
                      className="ti ti-chevron-right work-card__chev"
                      aria-hidden="true"
                    />
                  </button>
                ))}
              </div>
            ) : (
              // A tool is open — the cards collapse to a 2×2 tile grid (same
              // footprint as the ambient grid); the active tile is highlighted,
              // and tapping another swaps the tool without going back to the
              // stack. A full-screen expand affordance is parked for later.
              <>
                <div className="work-grid">
                  {allWorkshopTools.map((tool) => (
                    <button
                      key={tool.name}
                      className={`work-tile ${tool.name === activeTool ? 'work-tile--on' : ''}`}
                      onClick={() => setActiveTool(tool.name)}
                    >
                      <i className={`ti ${tool.icon}`} aria-hidden="true" />{' '}
                      {tool.name}
                    </button>
                  ))}
                </div>
                {activeTool === 'Calendar' ? (
                  // The first wired tool — a read-only agenda of what's coming
                  // up, grouped by Perth day. No Jay in here by design; the tool
                  // is a clean window, his calendar awareness lives in the Front
                  // Room.
                  <div className="agenda">
                    {agendaEvents === null && !agendaError ? (
                      <div className="agenda__state">Loading…</div>
                    ) : agendaEvents === null && agendaError ? (
                      <div className="agenda__state">Couldn't load the agenda</div>
                    ) : agendaSections.length === 0 ? (
                      <div className="agenda__state">Nothing coming up</div>
                    ) : (
                      agendaSections.map((section) => (
                        <div className="agenda__day" key={section.key}>
                          <div
                            className={`agenda__head ${section.isToday ? 'agenda__head--today' : ''}`}
                          >
                            <span>{section.label}</span>
                            <span className="agenda__rule" />
                          </div>
                          {section.items.length === 0 ? (
                            <div className="agenda__empty">Nothing on</div>
                          ) : (
                            section.items.map((ev) => (
                              <div className="agenda__event" key={ev.key}>
                                <span className={`agenda__spine ${ev.spine}`} />
                                <div className="agenda__body">
                                  <div className="agenda__title">{ev.title}</div>
                                  <div className="agenda__meta">{ev.meta}</div>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      ))
                    )}
                  </div>
                ) : activeTool === 'Notion' ? (
                  // The third wired tool — a read-only finder across the whole
                  // cathedral: a recently-edited list by default, a search box
                  // up top, each row spined by the area it lives in, tapping it
                  // open in Notion. No Jay in here, same as the others.
                  <div className="notion">
                    <div className="notion__search">
                      <i
                        className="ti ti-search notion__search-icon"
                        aria-hidden="true"
                      />
                      <input
                        className="notion__input"
                        type="text"
                        placeholder="search the cathedral…"
                        aria-label="Search Notion"
                        value={notionQuery}
                        onChange={(e) => setNotionQuery(e.target.value)}
                      />
                      {notionQuery && (
                        <button
                          className="notion__clear"
                          aria-label="Clear search"
                          onClick={() => setNotionQuery('')}
                        >
                          <i className="ti ti-x" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    <div className="notion__list">
                      {notionList === null ? (
                        <div className="notion__state">
                          {notionListFailed
                            ? notionIsSearch
                              ? "Couldn't search the cathedral"
                              : "Couldn't load recent"
                            : notionIsSearch
                              ? 'Searching…'
                              : 'Loading…'}
                        </div>
                      ) : notionList.length === 0 ? (
                        <div className="notion__state">
                          {notionIsSearch ? 'No results' : 'Nothing recent'}
                        </div>
                      ) : (
                        notionList.map((r) => (
                          <a
                            className="notion__row"
                            key={r.id}
                            href={r.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <span
                              className={`notion__spine ${notionSpine(r.area)}`}
                            />
                            <span className="notion__body">
                              <span className="notion__title">{r.title}</span>
                              {r.breadcrumb && (
                                <span className="notion__crumb">
                                  {r.breadcrumb}
                                </span>
                              )}
                            </span>
                            <span className="notion__time">
                              {relativeTime(r.last_edited_time, Date.now())}
                            </span>
                          </a>
                        ))
                      )}
                    </div>
                  </div>
                ) : activeTool === 'Projects' ? (
                  // The second wired tool — a live, read-only list of EV25
                  // projects. Active and blocked float to the top, done sinks
                  // and dims. No Jay in here by design; like the agenda, it's a
                  // clean window — project awareness, if it ever exists, lives in
                  // the Front Room.
                  <div className="projects">
                    {projectsList === null && !projectsError ? (
                      <div className="projects__state">Loading…</div>
                    ) : projectsList === null && projectsError ? (
                      <div className="projects__state">Couldn't load projects</div>
                    ) : sortedProjects.length === 0 ? (
                      <div className="projects__state">No projects yet</div>
                    ) : (
                      sortedProjects.map((p) => {
                        const meta = projectMeta(p);
                        return (
                          <a
                            className={`project ${p.status === 'Done' ? 'project--done' : ''}`}
                            key={p.id}
                            href={p.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <div className="project__body">
                              <div className="project__name">{p.project}</div>
                              {meta && <div className="project__meta">{meta}</div>}
                            </div>
                            <span className={`pill ${projectPill(p.status)}`}>
                              {p.status ?? '—'}
                            </span>
                          </a>
                        );
                      })
                    )}
                  </div>
                ) : genericBlockOpen ? (
                  // A panel-built generic block — one renderer for all of
                  // them: merged sorted tiles, accent spine by source, chips
                  // in Notion's colour, click-through to the page. Read-only.
                  <div className="projects">
                    {(() => {
                      const def = (wsBlockDefs ?? []).find((b) => b.name === genericBlockOpen);
                      const tiles = blockTiles[genericBlockOpen];
                      if (tiles === undefined) {
                        return (
                          <div className="projects__state">
                            {blockErrors[genericBlockOpen]
                              ? "Couldn't load this block"
                              : 'Loading…'}
                          </div>
                        );
                      }
                      if (tiles.length === 0) {
                        return <div className="projects__state">Nothing here yet</div>;
                      }
                      return tiles.map((tile) => (
                        <a
                          className="wtile"
                          key={tile.id}
                          href={tile.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <span className={`wtile__spine ${wtileSpine(def, tile.source)}`} />
                          <span className="wtile__body">
                            <span className="wtile__title">{tile.title}</span>
                            {tile.props.length > 0 && (
                              <span className="wtile__props">
                                {tile.props.map((p) =>
                                  p.kind === 'chips' ? (
                                    p.chips.map((c, i) => (
                                      <span
                                        key={`${p.name}:${c.label}:${i}`}
                                        className={`pill pill--n-${c.color}`}
                                      >
                                        {c.label}
                                      </span>
                                    ))
                                  ) : p.kind === 'date' ? (
                                    p.value ? (
                                      <span key={p.name}>{projectDate(p.value)}</span>
                                    ) : null
                                  ) : (
                                    // Unsupported type — an honest dash, never
                                    // a guess, never a broken render.
                                    <span key={p.name} className="wtile__dash">
                                      —
                                    </span>
                                  ),
                                )}
                              </span>
                            )}
                          </span>
                        </a>
                      ));
                    })()}
                  </div>
                ) : (
                  // Placeholder — an unknown tool name (e.g. a block deleted
                  // in the panel while open) degrades to the stub, honestly.
                  <div className="work-stub">
                    <i className="ti ti-tool work-stub__icon" aria-hidden="true" />
                    <div className="work-stub__title">{activeTool} open</div>
                    <div className="work-stub__hint">
                      fills the room — tap another tile to swap
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        {/* Post Box — the mail room. Mounted alongside the others so its
            state survives a trip to another room and back. */}
        <div
          className={`room-view ${activeRoom === 'post_box' ? 'room-view--on' : ''}`}
        >
          {readiness && !readiness.gmail ? (
            <RoomNeeds
              icon="ti-mail"
              room="The Post Box"
              needs="the Gmail OAuth secrets (client id, secret, refresh token — set at deploy time)"
              circuit="Keys (see the README's Gmail section)"
              onOpenFuseBox={null}
            />
          ) : (
            <PostBox active={activeRoom === 'post_box'} />
          )}
        </div>
        {/* The Hearth — home control. Mounted alongside the others so its
            state (collapsed sections, last-good house read) survives a trip
            to another room and back. */}
        <div
          className={`room-view ${activeRoom === 'hearth' ? 'room-view--on' : ''}`}
        >
          {readiness && !readiness.ha ? (
            <RoomNeeds
              icon="ti-home"
              room="The Hearth"
              needs="the Home Assistant URL and token"
              circuit="Keys"
              onOpenFuseBox={openFuseBox}
            />
          ) : (
            <Hearth active={activeRoom === 'hearth'} />
          )}
        </div>
        {/* The Listening Room — the music room, native on spotify.ts. */}
        <div
          className={`room-view ${activeRoom === 'listening_room' ? 'room-view--on' : ''}`}
        >
          {readiness && !readiness.spotify ? (
            <RoomNeeds
              icon="ti-headphones"
              room="The Listening Room"
              needs="the Spotify OAuth secrets (client id, secret, refresh token — set at deploy time)"
              circuit="Keys (see the README's Spotify section)"
              onOpenFuseBox={null}
            />
          ) : (
            <ListeningRoom active={activeRoom === 'listening_room'} />
          )}
        </div>

        {/* The Gallery — pretty pictures, one pipeline, three doors. */}
        <div className={`room-view ${activeRoom === 'gallery' ? 'room-view--on' : ''}`}>
          {readiness && !readiness.getimg ? (
            <RoomNeeds
              icon="ti-photo"
              room="The Gallery"
              needs="the getimg key"
              circuit="Keys"
              onOpenFuseBox={openFuseBox}
            />
          ) : (
            <Gallery active={activeRoom === 'gallery'} />
          )}
        </div>

        {/* The Fuse Box — not a room: the service panel, desktop-only,
            behind its own side gate. Unmounted (not just hidden) below lg,
            so a phone never carries the panel's state or markup at all. */}
        {isDesktop && (
          <div className={`room-view ${activeRoom === 'fusebox' ? 'room-view--on' : ''}`}>
            <FuseBox active={activeRoom === 'fusebox'} />
          </div>
        )}
      </div>

      {/* Room drawer + scrim — now populated live from the backend */}
      <div
        className={`scrim ${drawerOpen ? 'scrim--open' : ''}`}
        onClick={() => setDrawerOpen(false)}
      />
      <aside className={`drawer ${drawerOpen ? 'drawer--open' : ''}`}>
        <div className="drawer__head">
          <span className="drawer__title">Rooms</span>
          <button
            className="drawer__close"
            aria-label="Close"
            onClick={() => setDrawerOpen(false)}
          >
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        {rooms.length === 0 && <div className="room">Loading rooms…</div>}

        {rooms.map((room) => {
          const live = room.status === 'live';
          const current = room.name === activeRoom;
          return (
            <button
              key={room.id}
              className={`room ${live ? 'room--live' : ''} ${current ? 'room--current' : ''}`}
              // Live rooms navigate and close the drawer; "soon" rooms are inert
              // and leave the drawer open, so a stray tap doesn't dump you out.
              onClick={() => {
                if (!live) return;
                setActiveRoom(room.name);
                setDrawerOpen(false);
              }}
            >
              <i className={`ti ${room.icon}`} aria-hidden="true" />
              {room.display_name}
              {!live && <span className="room__soon">soon</span>}
            </button>
          );
        })}

        {/* Below the rooms, visually separated: the house's controls, not
            places you live. The light switch is every-device (mode is device
            dressing); the Fuse Box stays desktop-only and frontend-owned
            rather than a rooms-table row (the room catalogue shouldn't have
            to lie about it being a room). */}
        <div className="drawer__divider" />
        <button
          className="room room--live drawer__lightswitch"
          onClick={toggleDecorMode}
          title="Switches this device only — the theme itself is house config, in the Fuse Box"
        >
          <i
            className={`ti ${decorMode === 'light' ? 'ti-moon' : 'ti-sun'}`}
            aria-hidden="true"
          />
          {decorMode === 'light' ? 'Dark mode' : 'Light mode'}
        </button>
        {isDesktop && (
          <button
            className={`room room--live drawer__fusebox ${activeRoom === 'fusebox' ? 'room--current' : ''}`}
            onClick={() => {
              setActiveRoom('fusebox');
              setDrawerOpen(false);
            }}
          >
            <i className="ti ti-bolt" aria-hidden="true" />
            The Fuse Box
          </button>
        )}

        {/* Sync health — a quiet line: green when the cron workers are fine, a
            warning (with how long) when one's failing. Wave 3C's surface. */}
        {syncHealth && syncHealth.length > 0 && (() => {
          const bad = syncHealth.filter((h) => !h.ok);
          return (
            <div className={`drawer__sync ${bad.length ? 'drawer__sync--bad' : ''}`}>
              <span className={`drawer__syncdot ${bad.length ? '' : 'drawer__syncdot--ok'}`} />
              {bad.length === 0
                ? 'Syncs healthy'
                : bad
                    .map((h) => {
                      const name = h.worker.replace('-sync', '');
                      const since = h.last_ok_at
                        ? ` (last ok ${agoLabel(new Date(h.last_ok_at).getTime())})`
                        : '';
                      return `${name} sync failing${since}`;
                    })
                    .join(' · ')}
            </div>
          );
        })()}
      </aside>
    </div>
    </IdentityContext.Provider>
  );
}

export default App;
