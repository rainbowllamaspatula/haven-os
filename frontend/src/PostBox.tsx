/**
 * Post Box — the mail room.
 *
 * A full Gmail client as a Vale OS room: read, filter, triage, compose, send, and
 * capture-to-task. The core idea (Mail Client Scoping Notes): a "view" is a Gmail
 * label, so the view chips are label queries and relabelling = moving between
 * views. Filters not folders — a message shows in every view it's labelled into,
 * and a wrong sort is clutter, not loss.
 *
 * Four states, one at a time inside the room: the list, a read view, a compose
 * surface (no Jay here — drafting-with-Jay is the Front Room's job), and the
 * add-to-Task sheet. Notifications opt-in lives in the list header.
 *
 * Lives inside the live Front Room shell (the mockups' ambient strip is a
 * placeholder, ignored). Stays mounted with the room stage so state survives a
 * trip to another room and back.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { useReadSequence } from './hooks';

const VAPID_PUBLIC = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
// The account address for the compose From line rides in with /postbox/views
// (the postbox.from_address config row — WAS a hardcoded constant, Haven fork).

// ── View presentation (the server owns the list + order; this owns the colour) ─
// Concrete hex (the 30 May dark palette) rather than tokens — these dot colours
// are richer than the app's working token set, and pinning them keeps the chips
// readable without bloating :root. Décor circuit ruling (19 Jul): DELIBERATELY
// outside the theme — per-label accents are room content (like the label roster
// itself, a future circuit), and half-theming them would fracture the set.
// Listed in the Décor circuit's honesty notes.
const VIEW_COLOR: Record<string, string> = {
  inbox: '#73B6B8',
  ai: '#C29D54',
  personal: '#73B6B8',
  money: '#D5B97D',
  health: '#8BA89A',
  receipts: '#A8A59E',
  house_stuff: '#A2BCB0',
  travel: '#4A82A8',
  completed_travel: '#6699BD',
  book_stuff: '#C29D54',
  jon: '#4A9FA1',
  cold_outreach: '#D06A6A',
  work: '#8C6A3A',
  promotions: '#807D75',
};

type ViewChip = { key: string; label: string; kind: string; unread: number };
type Row = {
  id: string;
  threadId: string;
  messageId: string | null;
  from: string;
  fromAddress: string;
  subject: string;
  snippet: string;
  unread: boolean;
  starred: boolean;
  date: string | null;
  views: string[];
};
type FullMessage = Row & {
  to: string;
  cc: string;
  bodyHtml: string | null;
  bodyText: string | null;
};
// A saved draft, parsed back into the compose fields so it can be reopened.
type DraftRow = {
  draftId: string;
  to: string;
  subject: string;
  snippet: string;
  body: string;
  threadId: string | null;
  inReplyTo: string | null;
  date: string | null;
};

// Relative time for a row, matching the Workshop tools' convention.
function relTime(iso: string | null, now: number): string {
  if (!iso) return '';
  const sec = Math.round((now - new Date(iso).getTime()) / 1000);
  if (sec < 60) return 'now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.round(day / 7);
  if (wk < 5) return `${wk}w`;
  const mo = Math.round(day / 30);
  return `${mo}mo`;
}

// ── Perth date helpers (the quick-date chips + task dates) ───────────────────
const PERTH_TZ = 'Australia/Perth';
const PERTH_DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: PERTH_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const PERTH_LABEL_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: PERTH_TZ,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

// YYYY-MM-DD for "today in Perth", offset by whole days. PERTH_DAY_FMT already
// resolves the instant in Australia/Perth, so we format straight through it —
// NO manual +8h (that plus the Perth formatter was a double shift that rolled
// the date forward from 16:00 Perth on). Adding whole days is exact: Perth has
// no DST, so +24h always lands the same wall-clock time one day later. This
// mirrors App.tsx's DAY_KEY_FMT usage.
function perthDate(offsetDays = 0): string {
  const now = new Date();
  return PERTH_DAY_FMT.format(new Date(now.getTime() + offsetDays * 86400 * 1000));
}
// Perth weekday index (0=Sun) for today. Parse the Perth calendar date as UTC
// midnight so getUTCDay reads it back unshifted (a +08:00 parse would land on
// the previous UTC day and return the wrong weekday).
function perthDow(): number {
  return new Date(perthDate() + 'T00:00:00Z').getUTCDay();
}
function dateLabel(d: string): string {
  return PERTH_LABEL_FMT.format(new Date(d + 'T00:00:00+08:00'));
}

// The "Bump" quick-date chips → a resolved YYYY-MM-DD.
function quickDate(kind: string): string {
  const dow = perthDow();
  switch (kind) {
    case 'today':
      return perthDate(0);
    case 'tomorrow':
      return perthDate(1);
    case 'weekend': {
      // The coming Saturday (today if it's already the weekend).
      if (dow === 6 || dow === 0) return perthDate(0);
      return perthDate(6 - dow);
    }
    case 'next_week': {
      // The coming Monday.
      const toMon = (8 - dow) % 7 || 7;
      return perthDate(toMon);
    }
    default:
      return perthDate(0);
  }
}

// ── Gmail deep-link (for the captured task's body) ───────────────────────────
// Desktop web resolves the exact message via rfc822msgid:; Android can only land
// on the inbox (Google limit) so we force the native app with a web fallback.
const IS_ANDROID = /Android/i.test(navigator.userAgent);
function gmailUrl(m: { messageId: string | null; threadId: string }): string {
  const web = m.messageId
    ? `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(m.messageId)}`
    : `https://mail.google.com/mail/u/0/#inbox/${m.threadId}`;
  if (IS_ANDROID) {
    return `intent://mail.google.com/mail/u/0/#Intent;scheme=https;package=com.google.android.gm;S.browser_fallback_url=${encodeURIComponent(web)};end`;
  }
  return web;
}

// ── Web Push helpers ─────────────────────────────────────────────────────────
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ── Task category options (live EV25-Tasks select, audited) ──────────────────
const CATEGORIES: { name: string; color: string }[] = [
  { name: 'Personal', color: '#E255A1' },
  { name: 'Home', color: '#A87B4A' },
  { name: 'Finance', color: '#C44545' },
  { name: 'Errand', color: '#E89B2C' },
  { name: 'Health', color: '#2E8B57' },
  { name: 'Hobby', color: '#9B6FC2' },
  { name: 'Content', color: '#807D75' },
  { name: 'Habits', color: '#2E8B57' },
  { name: 'Dailies', color: '#2E8B57' },
  { name: 'Home Happening', color: '#A87B4A' },
  { name: 'Family', color: '#E255A1' },
  { name: 'Friends', color: '#E27A55' },
  { name: 'Work', color: '#807D75' },
];

const initials = (name: string) => (name.trim()[0] ?? '?').toUpperCase();

export function PostBox({ active }: { active: boolean }) {
  const [views, setViews] = useState<ViewChip[] | null>(null);
  const [viewsError, setViewsError] = useState(false);
  const [activeView, setActiveView] = useState('inbox');
  const [allViewsOpen, setAllViewsOpen] = useState(false);

  const [rows, setRows] = useState<Row[] | null>(null);
  const [rowsError, setRowsError] = useState(false);
  const [drafts, setDrafts] = useState<DraftRow[] | null>(null);
  const [draftCount, setDraftCount] = useState(0);
  // The account address for the compose From line (config, loaded with views).
  const [fromAddress, setFromAddress] = useState<string | null>(null);
  // The armed bin: Gmail's drafts.delete is permanent (no trash stop), so one
  // stray thumb shouldn't do it. First tap arms this draft's bin, second tap
  // deletes; it disarms on its own after a few seconds or when the list reloads.
  const [armedDel, setArmedDel] = useState<string | null>(null);
  useEffect(() => {
    if (!armedDel) return;
    const t = setTimeout(() => setArmedDel(null), 4_000);
    return () => clearTimeout(t);
  }, [armedDel]);

  const [open, setOpen] = useState<FullMessage | null>(null);
  const [openLoading, setOpenLoading] = useState(false);

  const [compose, setCompose] = useState<{
    to: string;
    subject: string;
    body: string;
    inReplyTo: string | null;
    threadId: string | null;
    draftId: string | null;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [taskFor, setTaskFor] = useState<FullMessage | null>(null);

  // "didn't take" flashes, keyed by message id (per-key timers so a star flash
  // and a triage flash on different rows don't cancel each other). A mutation
  // that fails restores the affected state and raises one of these.
  const [flash, setFlash] = useState<Record<string, string>>({});
  const flashTimers = useRef<Record<string, number>>({});
  const showFlash = useCallback((key: string, msg = "didn't take") => {
    setFlash((f) => ({ ...f, [key]: msg }));
    if (flashTimers.current[key]) clearTimeout(flashTimers.current[key]);
    flashTimers.current[key] = window.setTimeout(() => {
      setFlash((f) => {
        const { [key]: _drop, ...rest } = f;
        return rest;
      });
      delete flashTimers.current[key];
    }, 2500);
  }, []);

  const labelByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const v of views ?? []) m.set(v.key, v.label);
    return m;
  }, [views]);

  // Load the view chips when the room first becomes active (and refresh on
  // foreground return). Counts move as mail arrives + gets read.
  const loadViews = useCallback(() => {
    api(`/postbox/views`)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && Array.isArray(d.views)) {
          setViews(d.views);
          setDraftCount(d.draftCount ?? 0);
          if (typeof d.from_address === 'string') setFromAddress(d.from_address);
          setViewsError(false);
        } else setViewsError(true);
      })
      .catch(() => setViewsError(true));
  }, []);

  // Load the mail list for the active view. keep=true refreshes IN PLACE (last-good
  // rows stay + scroll until fresh land — a room re-entry or a foreground); keep=false
  // clears to "Loading…" (a view switch). Stale-guarded so a slow older load can't
  // clobber a newer view's rows.
  const rowsSeq = useReadSequence();
  const loadRows = useCallback(
    (view: string, keep = false) => {
      const s = rowsSeq.begin();
      if (!keep) {
        setRows(null);
        setRowsError(false);
      }
      api(`/postbox/messages?view=${encodeURIComponent(view)}`)
        .then((r) => r.json())
        .then((d) => {
          if (!rowsSeq.isCurrent(s)) return; // superseded by a newer load
          if (d.ok && Array.isArray(d.messages)) {
            setRows(d.messages);
            setRowsError(false);
          } else setRowsError(true);
        })
        .catch(() => {
          if (rowsSeq.isCurrent(s)) setRowsError(true);
        });
    },
    [rowsSeq],
  );

  // Load the drafts list (the Drafts chip). Reopened from here into compose.
  const loadDrafts = useCallback(() => {
    setDrafts(null);
    setArmedDel(null);
    api(`/postbox/drafts`)
      .then((r) => r.json())
      .then((d) => setDrafts(d.ok && Array.isArray(d.drafts) ? d.drafts : []))
      .catch(() => setDrafts([]));
  }, []);

  // Views + rows refresh on foreground (rows IN PLACE — no blank). activeView via a
  // ref so the listener needn't re-register on every switch.
  const activeViewRef = useRef(activeView);
  useEffect(() => {
    activeViewRef.current = activeView;
  }, [activeView]);
  useEffect(() => {
    if (!active) return;
    loadViews();
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      loadViews();
      const v = activeViewRef.current;
      if (v === 'drafts') loadDrafts();
      else loadRows(v, true);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [active, loadViews, loadRows, loadDrafts]);

  // View switch or room re-entry. A switch clears; a re-entry (same view) refreshes
  // in place so the list never blanks on the way back.
  const prevView = useRef<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const keep = prevView.current === activeView;
    prevView.current = activeView;
    if (activeView === 'drafts') loadDrafts();
    else loadRows(activeView, keep);
  }, [active, activeView, loadRows, loadDrafts]);

  // Open a message into the read view (the GET marks it read server-side). The
  // unread dot clears only when that succeeds — a failed open left the dot lying
  // "read" while the mail was still unread in Gmail. Stale-guarded so a slow open
  // can't clobber a newer one.
  const msgSeq = useReadSequence();
  function openMessage(id: string) {
    const wasUnread = rows?.find((m) => m.id === id)?.unread ?? false;
    setOpenLoading(true);
    const s = msgSeq.begin();
    api(`/postbox/message?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!msgSeq.isCurrent(s)) return; // a newer open superseded this
        if (d.ok && d.message) {
          setOpen(d.message);
          setRows((prev) => prev?.map((m) => (m.id === id ? { ...m, unread: false } : m)) ?? prev);
          // Reconcile the view chips: opening marked it read, so drop its unread
          // from the views it's in (+ inbox), rather than waiting for a refresh.
          if (wasUnread) {
            const inViews = new Set<string>([...(d.message.views ?? []), 'inbox']);
            setViews(
              (vs) =>
                vs?.map((v) => (inViews.has(v.key) && v.unread > 0 ? { ...v, unread: v.unread - 1 } : v)) ??
                vs,
            );
          }
        }
      })
      .catch(() => {})
      .finally(() => setOpenLoading(false));
  }

  // Relabel from the read view (the triage mechanism). Add/remove one view key.
  async function relabel(id: string, addKey: string | null, removeKey: string | null) {
    const add = addKey ? [addKey] : [];
    const remove = removeKey ? [removeKey] : [];
    // Snapshot for rollback if Gmail rejects the change.
    const prevOpen = open;
    const prevRows = rows;
    const applyOptimistic = (views: string[]) => {
      const next = new Set(views);
      if (addKey) next.add(addKey);
      if (removeKey) next.delete(removeKey);
      return [...next];
    };
    // Optimistic — on the open message AND its list row (the row lagged before).
    setOpen((prev) => (prev && prev.id === id ? { ...prev, views: applyOptimistic(prev.views) } : prev));
    setRows((prev) => prev?.map((m) => (m.id === id ? { ...m, views: applyOptimistic(m.views) } : m)) ?? prev);
    try {
      const res = await api(`/postbox/label`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, add, remove }),
      });
      const d = await res.json();
      if (!d.ok || !Array.isArray(d.views)) throw new Error(d.error ?? 'failed');
      // Reconcile both surfaces to the server's authoritative view list.
      setOpen((prev) => (prev && prev.id === id ? { ...prev, views: d.views } : prev));
      setRows((prev) => prev?.map((m) => (m.id === id ? { ...m, views: d.views } : m)) ?? prev);
      loadViews(); // counts shifted
    } catch {
      // Didn't take — snap both surfaces back and tell her.
      setOpen(prevOpen);
      setRows(prevRows);
      showFlash(id);
    }
  }

  // Star / unstar — the "keep in inbox" pin the auto-archive sweep spares.
  async function toggleStar(id: string, starred: boolean) {
    setOpen((prev) => (prev && prev.id === id ? { ...prev, starred } : prev));
    setRows((prev) => prev?.map((m) => (m.id === id ? { ...m, starred } : m)) ?? prev);
    try {
      const res = await api(`/postbox/star`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, starred }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error ?? 'failed');
    } catch {
      // Didn't take — flip the pin back on both surfaces and flash.
      setOpen((prev) => (prev && prev.id === id ? { ...prev, starred: !starred } : prev));
      setRows((prev) => prev?.map((m) => (m.id === id ? { ...m, starred: !starred } : m)) ?? prev);
      showFlash(id);
    }
  }

  // Archive or trash from the read view, then back to the list. On failure the
  // row comes back in place (Gmail never lost it) with a "didn't take" flash.
  async function triage(id: string, action: 'archive' | 'trash') {
    const prevRows = rows;
    setOpen(null);
    setRows((prev) => prev?.filter((m) => m.id !== id) ?? prev);
    try {
      const res = await api(`/postbox/triage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error ?? 'failed');
      loadViews();
    } catch {
      setRows(prevRows); // restore the list, original order intact
      showFlash(id);
    }
  }

  // Bin a draft from the list. Same optimistic contract as triage: the row goes
  // immediately, and if Gmail says no it comes back with a "didn't take" flash
  // (Gmail never lost it). Only ever called from an armed bin — this delete is
  // permanent, there's no trash to fish it out of.
  async function discardDraft(draftId: string) {
    const prevDrafts = drafts;
    setArmedDel(null);
    setDrafts((prev) => prev?.filter((d) => d.draftId !== draftId) ?? prev);
    setDraftCount((c) => Math.max(0, c - 1));
    try {
      const res = await api(`/postbox/draft/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error ?? 'failed');
    } catch {
      setDrafts(prevDrafts); // restore the list, original order intact
      setDraftCount((c) => c + 1);
      showFlash(draftId);
    }
  }

  // Open the compose surface, fresh or as a reply that pre-fills To + quotes.
  function startCompose() {
    setCompose({ to: '', subject: '', body: '', inReplyTo: null, threadId: null, draftId: null });
    setDraftSaved(false);
  }
  function startReply(m: FullMessage) {
    const quoted = (m.bodyText ?? m.snippet ?? '')
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n');
    setCompose({
      to: m.fromAddress,
      subject: m.subject.startsWith('Re:') ? m.subject : `Re: ${m.subject}`,
      body: `\n\nOn ${m.from} wrote:\n${quoted}`,
      inReplyTo: m.messageId,
      threadId: m.threadId,
      draftId: null,
    });
    setDraftSaved(false);
  }
  // A real forward: Fwd: subject, empty To, the original quoted below a standard
  // forwarded-message header. NOT threaded — no inReplyTo/threadId — so it starts
  // a fresh conversation to whoever she picks, not a reply to the sender.
  function startForward(m: FullMessage) {
    const when = m.date
      ? new Intl.DateTimeFormat('en-GB', {
          timeZone: PERTH_TZ,
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(m.date))
      : '';
    const fwdHeader = [
      '---------- Forwarded message ----------',
      `From: ${m.from} <${m.fromAddress}>`,
      when ? `Date: ${when}` : null,
      `Subject: ${m.subject}`,
      m.to ? `To: ${m.to}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    const original = m.bodyText ?? m.snippet ?? '';
    setCompose({
      to: '',
      subject: m.subject.startsWith('Fwd:') ? m.subject : `Fwd: ${m.subject}`,
      body: `\n\n${fwdHeader}\n\n${original}`,
      inReplyTo: null,
      threadId: null,
      draftId: null,
    });
    setDraftSaved(false);
  }
  // Reopen a saved draft into compose — carries its draftId so closing or
  // sending updates/clears that same draft rather than spawning a duplicate.
  function openDraft(d: DraftRow) {
    setCompose({
      to: d.to,
      subject: d.subject,
      body: d.body,
      inReplyTo: d.inReplyTo,
      threadId: d.threadId,
      draftId: d.draftId,
    });
    setDraftSaved(false);
  }

  // ── Compose autosave ─────────────────────────────────────────────────────
  // A backgrounded PWA can be killed by Android, losing a half-written reply. So
  // we debounce a draft POST while typing and save immediately on background. The
  // returned draftId is adopted so re-saves UPDATE the same draft, never duplicate.
  const composeRef = useRef(compose);
  useEffect(() => {
    composeRef.current = compose;
  }, [compose]);
  const savingDraft = useRef(false);
  const autosaveDraft = useCallback(async () => {
    const c = composeRef.current;
    if (!c || savingDraft.current) return;
    if (!(c.to.trim() || c.subject.trim() || c.body.trim())) return; // nothing to keep
    savingDraft.current = true;
    try {
      const res = await api(`/postbox/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(c),
      });
      const d = await res.json();
      if (d.ok) {
        setDraftSaved(true);
        if (d.draftId && !composeRef.current?.draftId) {
          setCompose((prev) => (prev ? { ...prev, draftId: d.draftId } : prev));
        }
      }
    } catch {
      /* best-effort — the close save or next tick retries */
    } finally {
      savingDraft.current = false;
    }
  }, []);
  useEffect(() => {
    if (!compose) return;
    const t = setTimeout(() => void autosaveDraft(), 2_000); // debounced while typing
    return () => clearTimeout(t);
  }, [compose, autosaveDraft]);
  useEffect(() => {
    if (!compose) return;
    const onVis = () => {
      if (document.visibilityState === 'hidden') void autosaveDraft(); // save on background
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [compose, autosaveDraft]);

  async function doSend() {
    if (!compose || sending || !compose.to.trim() || !compose.subject.trim()) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await api(`/postbox/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(compose),
      });
      const d = await res.json();
      if (d.ok) {
        setCompose(null);
        setOpen(null);
        if (activeView === 'drafts') loadDrafts();
        else loadRows(activeView, true);
        loadViews();
      } else {
        setSendError(d.error ?? 'unknown error');
      }
    } catch {
      setSendError('couldn’t reach the Worker');
    } finally {
      setSending(false);
    }
  }

  // Closing a half-written message saves a draft (never binned), per the brief.
  async function closeCompose() {
    if (!compose) return;
    const hasContent = compose.to.trim() || compose.subject.trim() || compose.body.trim();
    const c = compose;
    setCompose(null);
    // Save (or, with a draftId, update in place) only if there's something to
    // keep — an empty new compose leaves no draft behind.
    if (hasContent) {
      try {
        await api(`/postbox/draft`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(c),
        });
      } catch {
        /* best-effort */
      }
      loadViews();
      if (activeView === 'drafts') loadDrafts();
    }
  }

  // ── Render: one surface at a time ──────────────────────────────────────────
  if (compose) {
    return (
      <ComposeView
        compose={compose}
        setCompose={setCompose}
        sending={sending}
        draftSaved={draftSaved}
        sendError={sendError}
        fromAddress={fromAddress}
        onSend={doSend}
        onClose={closeCompose}
      />
    );
  }

  if (open) {
    return (
      <>
        <ReadView
          msg={open}
          labelByKey={labelByKey}
          allViews={views ?? []}
          flash={flash[open.id]}
          onBack={() => setOpen(null)}
          onRelabel={relabel}
          onTriage={triage}
          onStar={(starred) => toggleStar(open.id, starred)}
          onReply={() => startReply(open)}
          onForward={() => startForward(open)}
          onTask={() => setTaskFor(open)}
        />
        {taskFor && <TaskSheet msg={taskFor} onClose={() => setTaskFor(null)} />}
      </>
    );
  }

  // The list.
  const now = Date.now();
  return (
    <div className="pb">
      <div className="pb__chips">
        {(views ?? []).map((v) => {
          const on = v.key === activeView;
          return (
            <Fragment key={v.key}>
              <button
                className={`pb__chip ${on ? 'pb__chip--on' : ''}`}
                onClick={() => setActiveView(v.key)}
              >
                {v.key !== 'inbox' && (
                  <span className="pb__chipdot" style={{ background: VIEW_COLOR[v.key] }} />
                )}
                {v.label}
                {v.unread > 0 && <span className="pb__chipcount">{v.unread}</span>}
              </button>
              {/* Drafts rides right behind Inbox so it's the first thing after the
                  default view, never lost at the tail of fourteen chips. */}
              {v.key === 'inbox' && (
                <button
                  className={`pb__chip ${activeView === 'drafts' ? 'pb__chip--on' : ''}`}
                  onClick={() => setActiveView('drafts')}
                >
                  <i className="ti ti-file-text" aria-hidden="true" />
                  Drafts
                  {draftCount > 0 && <span className="pb__chipcount">{draftCount}</span>}
                </button>
              )}
            </Fragment>
          );
        })}
        <button
          className="pb__chip pb__chip--grid"
          aria-label="All views"
          onClick={() => setAllViewsOpen(true)}
        >
          <i className="ti ti-layout-grid" aria-hidden="true" />
        </button>
      </div>

      <PushOptIn />

      <div className="pb__list">
        {activeView === 'drafts' ? (
          drafts === null ? (
            <div className="pb__state">Loading…</div>
          ) : drafts.length === 0 ? (
            <div className="pb__state">No drafts</div>
          ) : (
            drafts.map((d) => (
              <div
                key={d.draftId}
                className={`pb__draftrow ${flash[d.draftId] ? 'pb__row--bad' : ''}`}
              >
                <button className="pb__row pb__row--read" onClick={() => openDraft(d)}>
                  <span className="pb__dot pb__dot--read" />
                  <span className="pb__rbody">
                    <span className="pb__rtop">
                      <span className="pb__from">{d.to ? `To ${d.to}` : '(no recipient)'}</span>
                      {flash[d.draftId] && <span className="pb__flash">{flash[d.draftId]}</span>}
                      {d.date && <span className="pb__time">{relTime(d.date, now)}</span>}
                    </span>
                    <span className="pb__subject">{d.subject || '(no subject)'}</span>
                    <span className="pb__snippet">{d.snippet || d.body}</span>
                  </span>
                </button>
                <button
                  className={`pb__draftdel ${armedDel === d.draftId ? 'pb__draftdel--armed' : ''}`}
                  aria-label={armedDel === d.draftId ? 'Tap again to delete draft' : 'Delete draft'}
                  onClick={() =>
                    armedDel === d.draftId ? void discardDraft(d.draftId) : setArmedDel(d.draftId)
                  }
                >
                  <i className={`ti ${armedDel === d.draftId ? 'ti-trash-x' : 'ti-trash'}`} aria-hidden="true" />
                </button>
              </div>
            ))
          )
        ) : rows === null ? (
          rowsError ? (
            <div className="pb__state">
              Couldn't load mail.{' '}
              <button className="pb__retry" onClick={() => loadRows(activeView)}>
                <i className="ti ti-refresh" aria-hidden="true" /> Retry
              </button>
            </div>
          ) : (
            <div className="pb__state">Loading…</div>
          )
        ) : rows.length === 0 ? (
          <div className="pb__state">Nothing here</div>
        ) : (
          rows.map((m) => (
            <button
              key={m.id}
              className={`pb__row ${m.unread ? '' : 'pb__row--read'} ${flash[m.id] ? 'pb__row--bad' : ''}`}
              onClick={() => openMessage(m.id)}
            >
              <span className={`pb__dot ${m.unread ? 'pb__dot--unread' : 'pb__dot--read'}`} />
              <span className="pb__rbody">
                <span className="pb__rtop">
                  <span className="pb__from">{m.from}</span>
                  {flash[m.id] && <span className="pb__flash">{flash[m.id]}</span>}
                  {m.date && <span className="pb__time">{relTime(m.date, now)}</span>}
                </span>
                <span className="pb__subject">{m.subject}</span>
                <span className="pb__snippet">{m.snippet}</span>
                {m.views.filter((k) => k !== activeView).length > 0 && (
                  <span className="pb__labels">
                    {m.views
                      .filter((k) => k !== activeView)
                      .map((k) => (
                        <span key={k} className="pb__lab">
                          <span className="pb__labdot" style={{ background: VIEW_COLOR[k] }} />
                          {labelByKey.get(k) ?? k}
                        </span>
                      ))}
                  </span>
                )}
              </span>
            </button>
          ))
        )}
        {openLoading && <div className="pb__state">Opening…</div>}
        {viewsError && (
          <div className="pb__state pb__state--warn">
            Views out of sync.{' '}
            <button className="pb__retry" onClick={loadViews}>
              <i className="ti ti-refresh" aria-hidden="true" /> Refresh
            </button>
          </div>
        )}
      </div>

      <button className="pb__fab" aria-label="Compose" onClick={startCompose}>
        <i className="ti ti-pencil" aria-hidden="true" />
      </button>

      {allViewsOpen && (
        <AllViews
          views={views ?? []}
          active={activeView}
          onPick={(k) => {
            setActiveView(k);
            setAllViewsOpen(false);
          }}
          onClose={() => setAllViewsOpen(false)}
        />
      )}
    </div>
  );
}

// ── The full vertical view list (grid icon) ──────────────────────────────────
function AllViews({
  views,
  active,
  onPick,
  onClose,
}: {
  views: ViewChip[];
  active: string;
  onPick: (k: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="pb-sheet" onClick={onClose}>
      <div className="pb-sheet__panel" onClick={(e) => e.stopPropagation()}>
        <div className="pb-sheet__grab" />
        <div className="pb-sheet__title">All views</div>
        <div className="pb-allviews">
          {views.map((v) => (
            <button
              key={v.key}
              className={`pb-allviews__row ${v.key === active ? 'pb-allviews__row--on' : ''}`}
              onClick={() => onPick(v.key)}
            >
              <span className="pb__labdot" style={{ background: VIEW_COLOR[v.key] }} />
              <span className="pb-allviews__name">{v.label}</span>
              {v.unread > 0 && <span className="pb__chipcount">{v.unread}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Read view ────────────────────────────────────────────────────────────────
// The message body. HTML emails render in a sandboxed iframe (scripts + forms
// blocked) that auto-sizes to its content; the injected wrapper styles constrain
// width and images so a wide marketing email can't overflow the column or scroll
// sideways. Plain text (or, failing that, the snippet) is the fallback. Remote
// images load — fine for a private single-user client; blocking them is a later lever.
function EmailBody({
  html,
  text,
  snippet,
}: {
  html: string | null;
  text: string | null;
  snippet: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(240);

  const measure = useCallback(() => {
    const doc = ref.current?.contentDocument;
    if (doc?.documentElement) setHeight(doc.documentElement.scrollHeight + 8);
  }, []);

  if (html) {
    // The canvas stays white (HTML mail assumes it), but link colour follows
    // the theme — CSS vars don't cross the iframe boundary, so the worn value
    // is read from the document and baked into the srcdoc.
    const linkColor =
      getComputedStyle(document.documentElement).getPropertyValue('--teal').trim() || '#52797C';
    const srcDoc =
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<base target="_blank"><style>` +
      `html,body{margin:0;padding:12px;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;` +
      `color:#1a1a1a;background:#fff;font-size:14px;line-height:1.5;word-break:break-word;overflow-x:hidden;}` +
      `img,table,video{max-width:100%!important;height:auto;}*{max-width:100%;box-sizing:border-box;}a{color:${linkColor};}` +
      `</style></head><body>${html}</body></html>`;
    return (
      <iframe
        ref={ref}
        className="pb-read__html"
        // allow-same-origin (but NOT allow-scripts) lets us read the document
        // height to auto-size; with scripts blocked the email still can't run code.
        // allow-popups lets a tapped link open in a new tab, and
        // allow-popups-to-escape-sandbox drops the sandbox on that new tab so a
        // JS-dependent destination (redirect trackers, etc.) actually loads
        // instead of opening blank. The boundary still holds INSIDE the email.
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={srcDoc}
        title="Email body"
        style={{ height }}
        onLoad={() => {
          measure();
          // Re-measure once images settle — the sandboxed doc can't message out.
          setTimeout(measure, 300);
          setTimeout(measure, 1200);
        }}
      />
    );
  }
  if (text) return <pre className="pb-read__text">{text}</pre>;
  return <div className="pb-read__text">{snippet}</div>;
}

function ReadView({
  msg,
  labelByKey,
  allViews,
  flash,
  onBack,
  onRelabel,
  onTriage,
  onStar,
  onReply,
  onForward,
  onTask,
}: {
  msg: FullMessage;
  labelByKey: Map<string, string>;
  allViews: ViewChip[];
  flash: string | undefined;
  onBack: () => void;
  onRelabel: (id: string, add: string | null, remove: string | null) => void;
  onTriage: (id: string, action: 'archive' | 'trash') => void;
  onStar: (starred: boolean) => void;
  onReply: () => void;
  onForward: () => void;
  onTask: () => void;
}) {
  const [adding, setAdding] = useState(false);
  // Views not already on the message — the "+ label" menu.
  const addable = allViews.filter(
    (v) => v.kind !== 'master' && v.kind !== 'category' && !msg.views.includes(v.key),
  );
  const dateText = msg.date
    ? new Intl.DateTimeFormat('en-GB', {
        timeZone: PERTH_TZ,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(msg.date))
    : '';

  return (
    <div className="pb-read">
      <div className="pb-read__bar">
        <button className="pb-ic" aria-label="Back" onClick={onBack}>
          <i className="ti ti-arrow-left" aria-hidden="true" />
        </button>
        <span className="pb-read__spacer" />
        <button
          className={`pb-ic ${msg.starred ? 'pb-ic--star' : ''}`}
          aria-label={msg.starred ? 'Unstar — allow auto-archive' : 'Star — keep in inbox'}
          title={msg.starred ? 'Starred — kept in inbox' : 'Star to keep in inbox'}
          onClick={() => onStar(!msg.starred)}
        >
          <i className="ti ti-star" aria-hidden="true" />
        </button>
        <button className="pb-ic pb-ic--task" aria-label="Add to Tasks" onClick={onTask}>
          <i className="ti ti-checkbox" aria-hidden="true" />
        </button>
        <button className="pb-ic" aria-label="Archive" onClick={() => onTriage(msg.id, 'archive')}>
          <i className="ti ti-archive" aria-hidden="true" />
        </button>
        <button className="pb-ic" aria-label="Delete" onClick={() => onTriage(msg.id, 'trash')}>
          <i className="ti ti-trash" aria-hidden="true" />
        </button>
      </div>

      {flash && <div className="pb-read__flash">{flash}</div>}

      <div className="pb-read__scroll">
        <div className="pb-read__subject">{msg.subject}</div>
        <div className="pb-read__sender">
          <span className="pb-read__av">{initials(msg.from)}</span>
          <span className="pb-read__meta">
            <span className="pb-read__name">{msg.from}</span>
            <span className="pb-read__addr">{msg.fromAddress}</span>
          </span>
          {dateText && <span className="pb-read__date">{dateText}</span>}
        </div>

        {/* Inline editable labels — the relabel mechanism */}
        <div className="pb-read__labels">
          <span className="pb-read__lk">In</span>
          {msg.views.length === 0 && <span className="pb-read__none">Inbox only</span>}
          {msg.views.map((k) => (
            <span key={k} className="pb-lab">
              <span className="pb__labdot" style={{ background: VIEW_COLOR[k] }} />
              {labelByKey.get(k) ?? k}
              <button
                className="pb-lab__x"
                aria-label={`Remove ${labelByKey.get(k) ?? k}`}
                onClick={() => onRelabel(msg.id, null, k)}
              >
                <i className="ti ti-x" aria-hidden="true" />
              </button>
            </span>
          ))}
          <div className="pb-addlab">
            <button className="pb-addlab__btn" onClick={() => setAdding((v) => !v)}>
              <i className="ti ti-plus" aria-hidden="true" /> label
            </button>
            {adding && (
              <div className="pb-addlab__menu">
                {addable.length === 0 && <div className="pb-addlab__empty">All applied</div>}
                {addable.map((v) => (
                  <button
                    key={v.key}
                    className="pb-addlab__item"
                    onClick={() => {
                      onRelabel(msg.id, v.key, null);
                      setAdding(false);
                    }}
                  >
                    <span className="pb__labdot" style={{ background: VIEW_COLOR[v.key] }} />
                    {v.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Body — render the email's real HTML (auto-sized, sandboxed), or the
            plain-text part when there's no HTML. */}
        <div className="pb-read__body">
          <EmailBody html={msg.bodyHtml} text={msg.bodyText} snippet={msg.snippet} />
        </div>
      </div>

      <div className="pb-read__reply">
        <button className="pb-rbtn pb-rbtn--primary" onClick={onReply}>
          <i className="ti ti-arrow-back-up" aria-hidden="true" /> Reply
        </button>
        <button className="pb-rbtn" onClick={onForward}>
          <i className="ti ti-arrow-forward-up" aria-hidden="true" /> Forward
        </button>
      </div>
    </div>
  );
}

// ── Compose view ─────────────────────────────────────────────────────────────
function ComposeView({
  compose,
  setCompose,
  sending,
  draftSaved,
  sendError,
  fromAddress,
  onSend,
  onClose,
}: {
  compose: { to: string; subject: string; body: string; inReplyTo: string | null; threadId: string | null; draftId: string | null };
  setCompose: (c: typeof compose) => void;
  sending: boolean;
  draftSaved: boolean;
  sendError: string | null;
  fromAddress: string | null;
  onSend: () => void;
  onClose: () => void;
}) {
  return (
    <div className="pb-compose">
      <div className="pb-compose__bar">
        <button className="pb-ic" aria-label="Close (save draft)" onClick={onClose}>
          <i className="ti ti-x" aria-hidden="true" />
        </button>
        <span className="pb-compose__title">{compose.inReplyTo ? 'Reply' : 'New message'}</span>
        <span className="pb-read__spacer" />
        <button className="pb-send" onClick={onSend} disabled={sending}>
          {sending ? 'Sending…' : 'Send'} <i className="ti ti-send" aria-hidden="true" />
        </button>
      </div>
      <div className="pb-compose__fields">
        <label className="pb-field">
          <span className="pb-field__l">To</span>
          <input
            className="pb-field__i"
            value={compose.to}
            placeholder="recipient@…"
            onChange={(e) => setCompose({ ...compose, to: e.target.value })}
          />
        </label>
        <div className="pb-field">
          <span className="pb-field__l">From</span>
          <span className="pb-field__from">{fromAddress ?? 'this account'}</span>
        </div>
        <label className="pb-field">
          <span className="pb-field__l">Subject</span>
          <input
            className="pb-field__i"
            value={compose.subject}
            onChange={(e) => setCompose({ ...compose, subject: e.target.value })}
          />
        </label>
        <textarea
          className="pb-compose__body"
          value={compose.body}
          placeholder="Write your message…"
          onChange={(e) => setCompose({ ...compose, body: e.target.value })}
        />
      </div>
      {sendError && <div className="pb-compose__err">Couldn’t send — {sendError}</div>}
      <div className="pb-compose__foot">
        {draftSaved && <span className="pb-compose__saved">Draft saved</span>}
        <span className="pb-compose__hint">Closing saves a draft · autosaves as you type</span>
      </div>
    </div>
  );
}

// ── Add-to-Task sheet ────────────────────────────────────────────────────────
const QUICK = [
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'weekend', label: 'This weekend' },
  { key: 'next_week', label: 'Next week' },
];

function TaskSheet({ msg, onClose }: { msg: FullMessage; onClose: () => void }) {
  const [title, setTitle] = useState(msg.subject);
  const [quick, setQuick] = useState('next_week');
  const [date, setDate] = useState(quickDate('next_week'));
  const [time, setTime] = useState<string | null>(null);
  const [category, setCategory] = useState('Personal');
  const [highPriority, setHighPriority] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);

  function pickQuick(k: string) {
    setQuick(k);
    setDate(quickDate(k));
  }

  // Ask the backend (a small Haiku call) for an action-oriented title. Only runs
  // on tap; falls back silently to whatever's in the field on failure.
  async function suggestTitle() {
    if (suggesting) return;
    setSuggesting(true);
    try {
      const res = await api(`/postbox/suggest-title`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: msg.subject, snippet: msg.snippet, from: msg.from }),
      });
      const d = await res.json();
      if (d.ok && d.title) setTitle(d.title);
    } catch {
      /* leave the current title as-is */
    } finally {
      setSuggesting(false);
    }
  }

  async function add() {
    if (saving) return;
    setSaving(true);
    setTaskError(null);
    try {
      const res = await api(`/postbox/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          date,
          time,
          category,
          highPriority,
          gmailUrl: gmailUrl(msg),
          snippet: msg.snippet,
          subject: msg.subject,
          from: msg.from,
        }),
      });
      const d = await res.json();
      if (d.ok) {
        setDone(true);
        setTimeout(onClose, 900);
      } else {
        setTaskError(d.error ?? 'unknown error');
      }
    } catch {
      setTaskError('couldn’t reach the backend');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pb-sheet" onClick={onClose}>
      <div className="pb-sheet__panel" onClick={(e) => e.stopPropagation()}>
        <div className="pb-sheet__grab" />
        <div className="pb-task__head">
          <div>
            <div className="pb-sheet__title">Add to Tasks</div>
            <div className="pb-task__from">
              from <b>{msg.from}</b> · {msg.subject}
            </div>
          </div>
          <span className="pb-task__db">EV25 · Tasks</span>
        </div>

        <div className="pb-task__body">
          <div className="pb-fgroup">
            <div className="pb-flbl">Task</div>
            <input className="pb-taskname" value={title} onChange={(e) => setTitle(e.target.value)} />
            <button className="pb-suggest" onClick={suggestTitle} disabled={suggesting}>
              <i className="ti ti-sparkles" aria-hidden="true" />
              {suggesting ? 'Thinking…' : 'Suggest an action title'}
            </button>
          </div>

          <div className="pb-fgroup">
            <div className="pb-flbl">Follow up</div>
            <div className="pb-chiprow">
              {QUICK.map((q) => (
                <button
                  key={q.key}
                  className={`pb-dchip ${quick === q.key ? 'pb-dchip--on' : ''}`}
                  onClick={() => pickQuick(q.key)}
                >
                  {q.label}
                </button>
              ))}
            </div>
            <div className="pb-daterow">
              <input
                className="pb-dateinput"
                type="date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setQuick('pick');
                }}
              />
              {time === null ? (
                <button className="pb-timebtn" onClick={() => setTime('09:00')}>
                  <i className="ti ti-clock" aria-hidden="true" /> Add time
                </button>
              ) : (
                <>
                  <input
                    className="pb-dateinput"
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                  />
                  <button className="pb-allday" onClick={() => setTime(null)}>
                    All day
                  </button>
                </>
              )}
            </div>
            <div className="pb-task__when">
              {dateLabel(date)}
              {time ? ` · ${time}` : ' · all day'} → Assigned + Due
            </div>
          </div>

          <div className="pb-fgroup">
            <div className="pb-flbl">Category</div>
            <div className="pb-catwrap">
              {CATEGORIES.map((c) => (
                <button
                  key={c.name}
                  className={`pb-cchip ${category === c.name ? 'pb-cchip--on' : ''}`}
                  onClick={() => setCategory(c.name)}
                >
                  <span className="pb__labdot" style={{ background: c.color }} />
                  {c.name}
                </button>
              ))}
            </div>
          </div>

          <button
            className={`pb-prow ${highPriority ? 'pb-prow--on' : ''}`}
            onClick={() => setHighPriority((v) => !v)}
          >
            <i className="ti ti-flag" aria-hidden="true" />
            <span className="pb-prow__l">High priority</span>
            <span className={`pb-switch ${highPriority ? 'pb-switch--on' : ''}`}>
              <span className="pb-switch__k" />
            </span>
          </button>

          <div className="pb-attach">
            <i className="ti ti-link" aria-hidden="true" />
            <span>The Gmail link + snippet are saved into the task body.</span>
          </div>
        </div>

        {taskError && <div className="pb-compose__err">Couldn’t add the task — {taskError}</div>}
        <div className="pb-task__foot">
          <button className="pb-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="pb-add" onClick={add} disabled={saving || done}>
            <i className={`ti ${done ? 'ti-check' : 'ti-checkbox'}`} aria-hidden="true" />
            {done ? 'Added' : saving ? 'Adding…' : 'Add task'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Notification opt-in ──────────────────────────────────────────────────────
// Migration needs notifications, so the room makes enabling them a one-tap thing —
// but never auto-prompts (browser-hostile). Only shows when permission is still
// 'default' and a service worker is actually registered (production only).
function PushOptIn() {
  const [status, setStatus] = useState<'hidden' | 'offer' | 'working' | 'on' | 'denied'>('hidden');

  // Ensure a push subscription exists AND is stored on the server. Granting
  // notification permission does NOT create or send a subscription on its own —
  // so we reconcile here every time, idempotently (the server upserts on
  // endpoint). No user gesture is needed once permission is already granted.
  const syncSubscription = useCallback(async () => {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC!) as BufferSource,
      });
    }
    await api(`/postbox/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
  }, []);

  useEffect(() => {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !VAPID_PUBLIC) return;
    if (Notification.permission === 'denied') return;
    if (Notification.permission === 'granted') {
      // Already allowed — but a subscription may never have been created/stored
      // (the original bug). Reconcile it now; fall back to the button on failure.
      syncSubscription()
        .then(() => setStatus('on'))
        .catch((e) => {
          console.error('push sync failed:', e);
          setStatus('offer');
        });
      return;
    }
    // permission 'default' — offer the one-tap enable (the prompt needs a gesture).
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg) setStatus('offer');
    });
  }, [syncSubscription]);

  async function enable() {
    setStatus('working');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setStatus(perm === 'denied' ? 'denied' : 'offer');
        return;
      }
      await syncSubscription();
      setStatus('on');
    } catch (e) {
      console.error('push subscribe failed:', e);
      setStatus('offer');
    }
  }

  if (status === 'hidden' || status === 'on' || status === 'denied') return null;
  return (
    <div className="pb-push">
      <i className="ti ti-bell" aria-hidden="true" />
      <span className="pb-push__t">Get notified when mail arrives</span>
      <button className="pb-push__go" onClick={enable} disabled={status === 'working'}>
        {status === 'working' ? '…' : 'Turn on'}
      </button>
    </div>
  );
}

export default PostBox;
