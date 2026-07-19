/**
 * The Fuse Box — admin & config panel (Phase 1: the gate and the shell).
 *
 * Not a room: a panel on the wall you open when something needs rewiring,
 * then close. Desktop-only — App gates the render below `lg` (1024px) — and
 * that gate is ergonomics, not security. The security is the side gate:
 * the same house key, re-asked, minting a 15-minute server-side token
 * (fusebox.ts). Every /api/fusebox/* route checks it; this component's
 * prompt is presentation over that lock, never the lock itself.
 *
 * Deliberately more utilitarian than the rooms — same tokens, colder
 * weight. Mono labels, sharp corners, no warmth spent where none is due.
 *
 * Phase 1 ships the board with all six circuits visible but unwired; each
 * later phase turns one live. The re-lock countdown is honest: it mirrors
 * the server TTL, and any locked 401 from a panel route re-prompts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl } from './api';
import { agoLabel } from './hooks';
import { setDecorPreview, DECOR_CHANGED_EVENT } from './decor';
import { IDENTITY_CHANGED_EVENT, useIdentity } from './identity';

// The six circuits, in build-phase order. `wired: false` renders the
// placeholder card; phases 2-6 flip these one at a time.
const CIRCUITS = [
  {
    icon: 'ti-key',
    name: 'Keys',
    blurb: 'API keys — status and rotation. Values go in, never come out.',
    wired: true,
    view: 'keys' as const,
  },
  {
    icon: 'ti-fingerprint',
    name: 'Identity',
    blurb: 'The static core prompt, versioned and restorable. Voice ID.',
    wired: true,
    view: 'identity' as const,
  },
  {
    icon: 'ti-brain',
    name: 'Memories',
    blurb: 'The spine — browse, edit, archive, import.',
    wired: true,
    view: 'memories' as const,
  },
  {
    icon: 'ti-photo',
    name: 'References',
    blurb: 'The Gallery reference bank — faces, places, uploads.',
    wired: true,
    view: 'references' as const,
  },
  {
    icon: 'ti-flame',
    name: 'Hearth registry',
    blurb: "Lights, scenes, goodnight — this house's wiring, as data.",
    wired: true,
    view: 'hearth' as const,
  },
  {
    icon: 'ti-tool',
    name: 'Workshop mappings',
    blurb: 'Where the Workshop points in Notion. Rows, not code.',
    wired: true,
    view: 'workshop' as const,
  },
  {
    icon: 'ti-palette',
    name: 'Décor',
    blurb: 'Themes as data — colours, fonts, versions. Repaint with a row.',
    wired: true,
    view: 'decor' as const,
  },
];

// The panel's own fetch. A locked 401 (body carries `locked: true`) means
// the 15-minute token lapsed — that's the caller's cue to re-prompt, never
// a reason to reload. A 401 WITHOUT the marker is the house session dying
// under us, which gets api.ts's treatment: reload into the front door.
async function fbFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(apiUrl(path), init);
  if (res.status === 401 && import.meta.env.PROD) {
    const body = await res
      .clone()
      .json()
      .catch(() => null);
    if (!body?.locked) location.reload();
  }
  return res;
}

type Gate = 'checking' | 'locked' | 'unlocked';
type View =
  | 'board'
  | 'keys'
  | 'identity'
  | 'memories'
  | 'references'
  | 'hearth'
  | 'workshop'
  | 'decor';

type HearthRegistry = {
  scene_lights: string[];
  scenes: Array<{ name: string; icon: string; values: number[] }>;
  goodnight: { light: string; brightness: number };
};
// The registry extension (18 Jul brief): vacuum + audio rosters. HA can't
// list a vacuum's cleanable areas (verified live), so vacuum areas are typed
// and checked against the rail's area oracle before they're accepted.
type VacuumDef = { name: string; areas: string[] };
type AudioRoster = {
  everywhere: string | null;
  areas: Array<{ area: string; speakers: string[] }>;
};
// A curated icon shelf for scene chips — all present in the bundled Tabler
// subset (the ghost-glyphs lesson: never assume a filled variant exists).
const SCENE_ICONS = [
  'ti-bulb', 'ti-bulb-off', 'ti-movie', 'ti-flame', 'ti-moon', 'ti-sun',
  'ti-sparkles', 'ti-book', 'ti-music', 'ti-coffee',
];
type WorkshopMappings = Record<string, string>;
// Generic parent blocks (18 Jul brief) — a Workshop block as data: one or
// more Notion sources, per-source properties + VDS accent, one sorted list.
type BlockSource = { data_source_id: string; accent: string; properties: string[] };
type WorkshopBlock = {
  name: string;
  icon: string;
  sources: BlockSource[];
  sort: { property: string; direction: 'asc' | 'desc' };
};
type SchemaProp = { name: string; type: string; supported: boolean };
// The design system is the guardrail — named VDS accents only, no hex.
const VDS_ACCENTS = ['teal', 'bronze', 'sage', 'amber', 'red', 'muted'];
// Outline glyphs only — the bundled webfont carries no filled variants
// (the ghost-glyphs lesson).
const BLOCK_ICONS = [
  'ti-database', 'ti-notebook', 'ti-checklist', 'ti-book', 'ti-school',
  'ti-flask', 'ti-clipboard-text', 'ti-files', 'ti-list-details', 'ti-tag',
];
// Mapping KEYS are stable config identifiers (the Décor slot-key ruling);
// the labels are neutral descriptions of what each root does.
const MAPPING_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'journal_ds', label: "The companion's journal (data source)" },
  { key: 'projects_db', label: 'Projects (database)' },
  { key: 'projects_ds', label: 'Projects (data source)' },
  { key: 'jayhq_page', label: "The companion's HQ root (page)" },
  { key: 'snugglezone_page', label: 'Workspace root (page)' },
  { key: 'tasks_ds', label: 'Tasks (data source)' },
];

type RefRow = {
  id: string;
  slug: string;
  kind: 'character' | 'location';
  display_name: string;
  description: string;
  storage_path: string;
  active: boolean;
  created_at: string;
};
const REF_MAX_MB = 10;

const VIEW_META: Record<View, { title: string; sub: string }> = {
  board: { title: 'The Fuse Box', sub: 'Service panel — configure the house without a terminal.' },
  keys: { title: 'Keys', sub: 'Values go in, never come out. Rotation is deploy-free.' },
  identity: {
    title: 'Identity',
    sub: 'The static core, versioned. It rides every call — length is money.',
  },
  memories: { title: 'Memories', sub: 'The spine. Text edits re-embed or they do not save.' },
  references: {
    title: 'References',
    sub: 'The Gallery reference bank. A new face is an upload and a row — never a deploy.',
  },
  hearth: {
    title: 'Hearth registry',
    sub: "Lights, scenes, goodnight, vacuums, audio — this house's wiring, as data.",
  },
  workshop: {
    title: 'Workshop mappings',
    sub: 'Where the Workshop points in Notion. Repoint with a row, never a deploy.',
  },
  decor: {
    title: 'Décor',
    sub: 'The design system as data. Versioned like Identity — a bad paste never bricks the walls.',
  },
};

// ── Décor circuit types (mirror backend/src/decor.ts, the source of truth) ──
type DecorPair = { dark: string; light: string };
type DecorTokensDraft = { colors: Record<string, DecorPair>; fonts: Record<string, string> };
type DecorSlot = { key: string; label: string; group: string; neutral: DecorPair };
type DecorFontSlot = { key: string; label: string; neutral: string };
type DecorRegistry = {
  colors: DecorSlot[];
  fonts: DecorFontSlot[];
  font_options: Array<{ key: string; stack: string }>;
};
type DecorVersionMeta = {
  id: string;
  name: string;
  note: string | null;
  is_active: boolean;
  created_at: string;
};
type DecorImportReport = {
  colors: Record<string, { dark: string; light: string; source: string }>;
  fonts: Record<string, { pick: string; source: string }>;
  unmapped: string[];
  unfilled: string[];
  modes: 'both' | 'single';
};

const decorWhen = (iso: string) =>
  new Date(iso).toLocaleString('en-AU', {
    timeZone: 'Australia/Perth',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

// Client-side hints only — the server validates against the same lists
// exported from tools.ts, which remain the single source of truth.
const MEM_TYPES = ['anchor', 'canon', 'daily', 'resolved', 'roleplay', 'weekly'];
const MEM_CATEGORIES = [
  'dynamic', 'general', 'health', 'identity', 'leisure', 'lore', 'patterns',
  'people', 'places', 'preferences', 'projects', 'rituals', 'routines',
  'stressors', 'systems', 'work',
];

type MemRow = {
  id: string;
  type: string;
  category: string;
  title: string;
  content: string;
  tags: string[] | null;
  core: boolean;
  active: boolean;
  entry_date: string | null;
  created_at: string;
  updated_at: string | null;
};
type SpineStats = { core_count: number | null; always_on_count: number; approx_tokens: number };
type MemForm = {
  id: string | null; // null = adding new
  title: string;
  content: string;
  type: string;
  category: string;
  tags: string; // comma-separated in the form
  entry_date: string;
  core: boolean;
  active: boolean;
};

type PromptVersion = {
  id: string;
  note: string | null;
  created_at: string;
  chars: number;
  is_active: boolean;
};
type PromptData = {
  active: { id: string; content: string; note: string | null; created_at: string } | null;
  versions: PromptVersion[];
};

// One managed key's status row, as /api/fusebox/keys reports it. Metadata
// only — a value can never appear here because no value can ever come back.
type KeyRow = {
  name: string;
  secret_name: string;
  consumer: string;
  testable: boolean;
  set: boolean;
  modified: string | null;
};

export function FuseBox({ active }: { active: boolean }) {
  const houseIdentity = useIdentity();
  const [gate, setGate] = useState<Gate>('checking');
  const [remaining, setRemaining] = useState(0); // seconds until re-lock
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const pwRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<View>('board');

  // ── Keys circuit state ────────────────────────────────────────────────────
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [keysErr, setKeysErr] = useState('');
  // Which key's rotate input is open, and its draft value.
  const [rotating, setRotating] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [keyBusy, setKeyBusy] = useState<string | null>(null);
  // Per-key result line: save confirmations and test verdicts, honest either way.
  const [keyNotes, setKeyNotes] = useState<Record<string, { ok: boolean; text: string }>>({});

  const note = (name: string, ok: boolean, text: string) =>
    setKeyNotes((prev) => ({ ...prev, [name]: { ok, text } }));

  const loadKeys = useCallback(async () => {
    setKeysErr('');
    try {
      const res = await fbFetch('/fusebox/keys');
      const data = await res.json();
      if (data.ok) setKeys(data.keys);
      else setKeysErr(data.error ?? 'The keys circuit is not answering.');
    } catch {
      setKeysErr('The keys circuit is not answering.');
    }
  }, []);

  // Entering the keys view fetches fresh status; leaving clears transient UI.
  useEffect(() => {
    if (view === 'keys' && gate === 'unlocked' && active) loadKeys();
    if (view !== 'keys') {
      setRotating(null);
      setDraft('');
      setKeyNotes({});
    }
  }, [view, gate, active, loadKeys]);

  const saveDraft = useCallback(
    async (name: string) => {
      if (!draft.trim() || keyBusy) return;
      setKeyBusy(name);
      try {
        const res = await fbFetch(`/fusebox/keys/${name}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: draft }),
        });
        const data = await res.json();
        if (data.ok) {
          note(name, true, data.created ? 'Created in the store.' : 'Rotated in the store.');
          setRotating(null);
          setDraft('');
          loadKeys();
        } else {
          note(name, false, data.error ?? 'Save failed.');
        }
      } catch {
        note(name, false, 'Save failed — the store is not answering.');
      } finally {
        setKeyBusy(null);
      }
    },
    [draft, keyBusy, loadKeys],
  );

  const runTest = useCallback(
    async (name: string) => {
      if (keyBusy) return;
      setKeyBusy(name);
      note(name, true, 'Testing…');
      try {
        const res = await fbFetch(`/fusebox/keys/${name}/test`, { method: 'POST' });
        const data = await res.json();
        note(name, !!data.ok, data.detail ?? 'No verdict.');
      } catch {
        note(name, false, 'Test failed — the panel is not answering.');
      } finally {
        setKeyBusy(null);
      }
    },
    [keyBusy],
  );

  // ── Identity circuit state ────────────────────────────────────────────────
  const [promptData, setPromptData] = useState<PromptData | null>(null);
  const [promptErr, setPromptErr] = useState('');
  const [promptDraft, setPromptDraft] = useState('');
  const [draftNote, setDraftNote] = useState('');
  const [identityBusy, setIdentityBusy] = useState(false);
  const [promptMsg, setPromptMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<{ id: string; content: string } | null>(null);
  const [voiceId, setVoiceId] = useState('');
  const [modelId, setModelId] = useState('');
  const [voiceMsg, setVoiceMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // The names half of the circuit (Haven fork): who lives here.
  const [profileDraft, setProfileDraft] = useState({
    house_name: '',
    companion_name: '',
    user_name: '',
    companion_role: '',
    timezone: '',
  });
  const [profileMsg, setProfileMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadIdentity = useCallback(async () => {
    setPromptErr('');
    try {
      const [pRes, vRes, iRes] = await Promise.all([
        fbFetch('/fusebox/prompt'),
        fbFetch('/fusebox/voice'),
        fbFetch('/fusebox/identity'),
      ]);
      const p = await pRes.json();
      const v = await vRes.json();
      const i = await iRes.json();
      if (p.ok) {
        setPromptData({ active: p.active, versions: p.versions });
        // Entering the circuit resets the editor to the live version — this is
        // a service panel, not a draft box; unsaved text does not survive.
        setPromptDraft(p.active?.content ?? '');
      } else {
        setPromptErr(p.error ?? 'The identity circuit is not answering.');
      }
      if (v.ok) {
        setVoiceId(v.voice_id);
        setModelId(v.model_id);
      }
      if (i.ok && i.identity) {
        setProfileDraft({
          house_name: i.identity.house_name ?? '',
          companion_name: i.identity.companion_name ?? '',
          user_name: i.identity.user_name ?? '',
          companion_role: i.identity.companion_role ?? '',
          timezone: i.identity.timezone ?? '',
        });
      }
    } catch {
      setPromptErr('The identity circuit is not answering.');
    }
  }, []);

  const saveProfile = useCallback(async () => {
    if (identityBusy) return;
    setIdentityBusy(true);
    setProfileMsg(null);
    try {
      const res = await fbFetch('/fusebox/identity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profileDraft),
      });
      const data = await res.json();
      if (data.ok) {
        setProfileMsg({ ok: true, text: 'Saved. Every surface follows — no deploy.' });
        window.dispatchEvent(new Event(IDENTITY_CHANGED_EVENT));
      } else {
        setProfileMsg({ ok: false, text: data.error ?? 'Save failed.' });
      }
    } catch {
      setProfileMsg({ ok: false, text: 'Save failed — the panel is not answering.' });
    } finally {
      setIdentityBusy(false);
    }
  }, [identityBusy, profileDraft]);

  useEffect(() => {
    if (view === 'identity' && gate === 'unlocked' && active) loadIdentity();
    if (view !== 'identity') {
      setPromptMsg(null);
      setVoiceMsg(null);
      setPreview(null);
      setDraftNote('');
    }
  }, [view, gate, active, loadIdentity]);

  const savePrompt = useCallback(async () => {
    if (identityBusy || !promptDraft.trim()) return;
    setIdentityBusy(true);
    setPromptMsg(null);
    try {
      const res = await fbFetch('/fusebox/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: promptDraft, note: draftNote }),
      });
      const data = await res.json();
      if (data.ok) {
        setPromptMsg({ ok: true, text: 'Saved as the new active version. The next reply uses it.' });
        setDraftNote('');
        loadIdentity();
      } else {
        setPromptMsg({ ok: false, text: data.error ?? 'Save failed.' });
      }
    } catch {
      setPromptMsg({ ok: false, text: 'Save failed — the panel is not answering.' });
    } finally {
      setIdentityBusy(false);
    }
  }, [identityBusy, promptDraft, draftNote, loadIdentity]);

  const restoreVersion = useCallback(
    async (id: string) => {
      if (identityBusy) return;
      setIdentityBusy(true);
      setPromptMsg(null);
      try {
        const res = await fbFetch(`/fusebox/prompt/${id}/restore`, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          setPromptMsg({ ok: true, text: 'Restored. The next reply reverts to this version.' });
          setPreview(null);
          loadIdentity();
        } else {
          setPromptMsg({ ok: false, text: data.error ?? 'Restore failed.' });
        }
      } catch {
        setPromptMsg({ ok: false, text: 'Restore failed — the panel is not answering.' });
      } finally {
        setIdentityBusy(false);
      }
    },
    [identityBusy, loadIdentity],
  );

  const togglePreview = useCallback(
    async (id: string) => {
      if (preview?.id === id) {
        setPreview(null);
        return;
      }
      try {
        const res = await fbFetch(`/fusebox/prompt/${id}`);
        const data = await res.json();
        if (data.ok) setPreview({ id, content: data.version.content });
      } catch {
        /* preview is best-effort */
      }
    },
    [preview],
  );

  const saveVoice = useCallback(async () => {
    if (identityBusy || !voiceId.trim() || !modelId.trim()) return;
    setIdentityBusy(true);
    setVoiceMsg(null);
    try {
      const res = await fbFetch('/fusebox/voice', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice_id: voiceId, model_id: modelId }),
      });
      const data = await res.json();
      setVoiceMsg(
        data.ok
          ? { ok: true, text: 'Saved. The next voice note uses it.' }
          : { ok: false, text: data.error ?? 'Save failed.' },
      );
    } catch {
      setVoiceMsg({ ok: false, text: 'Save failed — the panel is not answering.' });
    } finally {
      setIdentityBusy(false);
    }
  }, [identityBusy, voiceId, modelId]);

  const validateVoice = useCallback(async () => {
    if (identityBusy) return;
    setIdentityBusy(true);
    setVoiceMsg({ ok: true, text: 'Checking against ElevenLabs…' });
    try {
      const res = await fbFetch('/fusebox/voice/validate', { method: 'POST' });
      const data = await res.json();
      setVoiceMsg({ ok: !!data.valid, text: data.detail ?? 'No verdict.' });
    } catch {
      setVoiceMsg({ ok: false, text: 'Validate failed — the panel is not answering.' });
    } finally {
      setIdentityBusy(false);
    }
  }, [identityBusy]);

  // ── Memories circuit state ────────────────────────────────────────────────
  const [memRows, setMemRows] = useState<MemRow[] | null>(null);
  const [memSpine, setMemSpine] = useState<SpineStats | null>(null);
  const [memErr, setMemErr] = useState('');
  const [memFilters, setMemFilters] = useState({
    type: '',
    category: '',
    core: '',
    active: 'active',
    q: '',
  });
  const [memForm, setMemForm] = useState<MemForm | null>(null);
  const [memBusy, setMemBusy] = useState(false);
  const [memMsg, setMemMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [memArmed, setMemArmed] = useState<string | null>(null); // delete two-tap
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importReport, setImportReport] = useState<string | null>(null);

  const loadMemories = useCallback(async () => {
    setMemErr('');
    const p = new URLSearchParams();
    if (memFilters.type) p.set('type', memFilters.type);
    if (memFilters.category) p.set('category', memFilters.category);
    if (memFilters.core) p.set('core', memFilters.core);
    if (memFilters.active) p.set('active', memFilters.active);
    if (memFilters.q.trim()) p.set('q', memFilters.q.trim());
    try {
      const res = await fbFetch(`/fusebox/memories?${p.toString()}`);
      const data = await res.json();
      if (data.ok) {
        setMemRows(data.memories);
        setMemSpine(data.spine);
      } else {
        setMemErr(data.error ?? 'The memories circuit is not answering.');
      }
    } catch {
      setMemErr('The memories circuit is not answering.');
    }
  }, [memFilters]);

  // Load on entry and whenever filters settle (400ms debounce covers typing
  // in the search box; selects settle instantly under the same timer).
  useEffect(() => {
    if (view !== 'memories' || gate !== 'unlocked' || !active) return;
    const t = setTimeout(loadMemories, 400);
    return () => clearTimeout(t);
  }, [view, gate, active, loadMemories]);
  useEffect(() => {
    if (view !== 'memories') {
      setMemForm(null);
      setMemMsg(null);
      setMemArmed(null);
      setImportOpen(false);
      setImportReport(null);
    }
  }, [view]);

  const openMemForm = useCallback((row: MemRow | null) => {
    setMemMsg(null);
    setMemForm(
      row
        ? {
            id: row.id,
            title: row.title,
            content: row.content,
            type: row.type,
            category: row.category,
            tags: (row.tags ?? []).join(', '),
            entry_date: row.entry_date ?? '',
            core: row.core,
            active: row.active,
          }
        : {
            id: null,
            title: '',
            content: '',
            type: 'canon',
            category: 'general',
            tags: '',
            entry_date: '',
            core: false,
            active: true,
          },
    );
  }, []);

  const saveMemForm = useCallback(async () => {
    if (!memForm || memBusy) return;
    setMemBusy(true);
    setMemMsg(null);
    const payload = {
      title: memForm.title,
      content: memForm.content,
      type: memForm.type,
      category: memForm.category,
      tags: memForm.tags.split(',').map((t) => t.trim()).filter(Boolean),
      entry_date: memForm.entry_date || undefined,
      core: memForm.core,
      active: memForm.active,
    };
    try {
      const res = await fbFetch(
        memForm.id ? `/fusebox/memories/${memForm.id}` : '/fusebox/memories',
        {
          method: memForm.id ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      const data = await res.json();
      if (data.ok) {
        setMemMsg({
          ok: true,
          text: memForm.id
            ? data.reembedded
              ? 'Saved — the vector was re-embedded with the new text.'
              : 'Saved — text unchanged, vector untouched.'
            : 'Added, embedded on the way in.',
        });
        setMemForm(null);
        loadMemories();
      } else {
        setMemMsg({ ok: false, text: data.error ?? 'Save failed.' });
      }
    } catch {
      setMemMsg({ ok: false, text: 'Save failed — the panel is not answering.' });
    } finally {
      setMemBusy(false);
    }
  }, [memForm, memBusy, loadMemories]);

  const toggleMemActive = useCallback(
    async (row: MemRow) => {
      if (memBusy) return;
      setMemBusy(true);
      setMemMsg(null);
      try {
        const res = await fbFetch(`/fusebox/memories/${row.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: !row.active }),
        });
        const data = await res.json();
        if (data.ok) {
          setMemMsg({ ok: true, text: row.active ? `Archived "${row.title}".` : `Restored "${row.title}".` });
          loadMemories();
        } else {
          setMemMsg({ ok: false, text: data.error ?? 'Archive failed.' });
        }
      } catch {
        setMemMsg({ ok: false, text: 'Archive failed — the panel is not answering.' });
      } finally {
        setMemBusy(false);
      }
    },
    [memBusy, loadMemories],
  );

  const deleteMem = useCallback(
    async (row: MemRow) => {
      if (memArmed !== row.id) {
        setMemArmed(row.id);
        setTimeout(() => setMemArmed((a) => (a === row.id ? null : a)), 3000);
        return;
      }
      setMemArmed(null);
      setMemBusy(true);
      setMemMsg(null);
      try {
        const res = await fbFetch(`/fusebox/memories/${row.id}`, { method: 'DELETE' });
        const data = await res.json();
        setMemMsg(
          data.ok
            ? { ok: true, text: `Deleted "${row.title}" — gone for good.` }
            : { ok: false, text: data.error ?? 'Delete failed.' },
        );
        if (data.ok) loadMemories();
      } catch {
        setMemMsg({ ok: false, text: 'Delete failed — the panel is not answering.' });
      } finally {
        setMemBusy(false);
      }
    },
    [memArmed, loadMemories],
  );

  // ── References circuit state ──────────────────────────────────────────────
  const [refRows, setRefRows] = useState<RefRow[] | null>(null);
  const [refErr, setRefErr] = useState('');
  const [refMsg, setRefMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [refBusy, setRefBusy] = useState(false);
  const [refArmed, setRefArmed] = useState<string | null>(null);
  // The editor: null closed; id null = new reference.
  const [refForm, setRefForm] = useState<{
    id: string | null;
    slug: string;
    kind: 'character' | 'location';
    display_name: string;
    description: string;
    active: boolean;
  } | null>(null);
  const refFileRef = useRef<HTMLInputElement>(null);

  const loadRefs = useCallback(async () => {
    setRefErr('');
    try {
      const res = await fbFetch('/fusebox/references');
      const data = await res.json();
      if (data.ok) setRefRows(data.references);
      else setRefErr(data.error ?? 'The references circuit is not answering.');
    } catch {
      setRefErr('The references circuit is not answering.');
    }
  }, []);

  useEffect(() => {
    if (view === 'references' && gate === 'unlocked' && active) loadRefs();
    if (view !== 'references') {
      setRefForm(null);
      setRefMsg(null);
      setRefArmed(null);
    }
  }, [view, gate, active, loadRefs]);

  const saveRef = useCallback(async () => {
    if (!refForm || refBusy) return;
    const file = refFileRef.current?.files?.[0] ?? null;
    if (!refForm.id && !file) {
      setRefMsg({ ok: false, text: 'A new reference needs an image.' });
      return;
    }
    // The 10 MiB door, checked client-side too so an oversized file never
    // even uploads — the server enforces the same line regardless.
    if (file && file.size > REF_MAX_MB * 1024 * 1024) {
      setRefMsg({
        ok: false,
        text: `That image is ${(file.size / (1024 * 1024)).toFixed(1)} MiB — getimg caps references at ${REF_MAX_MB} MiB. Re-export it smaller.`,
      });
      return;
    }
    setRefBusy(true);
    setRefMsg(null);
    try {
      let res: Response;
      if (file || !refForm.id) {
        // New reference, or image replacement: the multipart upsert-by-slug.
        const form = new FormData();
        form.set('slug', refForm.slug);
        form.set('kind', refForm.kind);
        form.set('display_name', refForm.display_name);
        form.set('description', refForm.description);
        form.set('active', String(refForm.active));
        if (file) form.set('image', file);
        res = await fbFetch('/fusebox/references', { method: 'POST', body: form });
      } else {
        // Words-only edit: JSON by id, image untouched.
        res = await fbFetch(`/fusebox/references/${refForm.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            display_name: refForm.display_name,
            description: refForm.description,
            kind: refForm.kind,
            active: refForm.active,
          }),
        });
      }
      const data = await res.json();
      if (data.ok) {
        setRefMsg({
          ok: true,
          text: data.created
            ? `Reference "${refForm.slug}" created — it is in the Gallery composer now, no deploy.`
            : 'Saved. The render pass reads the new words on its next generation.',
        });
        setRefForm(null);
        if (refFileRef.current) refFileRef.current.value = '';
        loadRefs();
      } else {
        setRefMsg({ ok: false, text: data.error ?? 'Save failed.' });
      }
    } catch {
      setRefMsg({ ok: false, text: 'Save failed — the panel is not answering.' });
    } finally {
      setRefBusy(false);
    }
  }, [refForm, refBusy, loadRefs]);

  const toggleRefActive = useCallback(
    async (row: RefRow) => {
      if (refBusy) return;
      setRefBusy(true);
      setRefMsg(null);
      try {
        const res = await fbFetch(`/fusebox/references/${row.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: !row.active }),
        });
        const data = await res.json();
        setRefMsg(
          data.ok
            ? { ok: true, text: row.active ? `"${row.slug}" hidden from the composer.` : `"${row.slug}" back in the composer.` }
            : { ok: false, text: data.error ?? 'Update failed.' },
        );
        if (data.ok) loadRefs();
      } catch {
        setRefMsg({ ok: false, text: 'Update failed — the panel is not answering.' });
      } finally {
        setRefBusy(false);
      }
    },
    [refBusy, loadRefs],
  );

  const deleteRef = useCallback(
    async (row: RefRow) => {
      if (refArmed !== row.id) {
        setRefArmed(row.id);
        setTimeout(() => setRefArmed((a) => (a === row.id ? null : a)), 3000);
        return;
      }
      setRefArmed(null);
      setRefBusy(true);
      try {
        const res = await fbFetch(`/fusebox/references/${row.id}`, { method: 'DELETE' });
        const data = await res.json();
        setRefMsg(
          data.ok
            ? { ok: true, text: `Deleted "${row.slug}" — row and image both gone.` }
            : { ok: false, text: data.error ?? 'Delete failed.' },
        );
        if (data.ok) loadRefs();
      } catch {
        setRefMsg({ ok: false, text: 'Delete failed — the panel is not answering.' });
      } finally {
        setRefBusy(false);
      }
    },
    [refArmed, loadRefs],
  );

  // ── Hearth + Workshop circuit state ───────────────────────────────────────
  const [hearthReg, setHearthReg] = useState<HearthRegistry | null>(null);
  const [hearthMsg, setHearthMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [hearthBusy, setHearthBusy] = useState(false);
  const [haLights, setHaLights] = useState<Array<{ name: string; area: string | null }> | null>(null);
  // The roster halves (18 Jul extension) — each saves independently.
  const [vacRoster, setVacRoster] = useState<VacuumDef[] | null>(null);
  const [vacMsg, setVacMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [vacBusy, setVacBusy] = useState(false);
  const [areaDrafts, setAreaDrafts] = useState<Record<number, string>>({});
  const [areaChecking, setAreaChecking] = useState<number | null>(null);
  const [audioRoster, setAudioRoster] = useState<AudioRoster | null>(null);
  const [audioMsg, setAudioMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [audioBusy, setAudioBusy] = useState(false);
  const [speakerDrafts, setSpeakerDrafts] = useState<Record<number, string>>({});
  const [newAreaDraft, setNewAreaDraft] = useState('');
  const [newSpeakerDraft, setNewSpeakerDraft] = useState('');
  // What the fetch-from-HA read saw beyond lights — feeds both roster editors.
  const [haMedia, setHaMedia] = useState<Array<{ name: string; area: string | null }> | null>(null);
  const [haVacuums, setHaVacuums] = useState<Array<{ name: string }> | null>(null);
  const [wsMappings, setWsMappings] = useState<WorkshopMappings | null>(null);
  const [wsMsg, setWsMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [wsBusy, setWsBusy] = useState(false);
  const [wsDatabases, setWsDatabases] = useState<Array<{ id: string; title: string }> | null>(null);
  // The generic-block builder (18 Jul extension).
  const [wsBlocks, setWsBlocks] = useState<WorkshopBlock[] | null>(null);
  const [blocksMsg, setBlocksMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [blocksBusy, setBlocksBusy] = useState(false);
  // Fetched per-source schemas: ds id → property list (or 'loading').
  const [schemas, setSchemas] = useState<Record<string, SchemaProp[] | 'loading'>>({});

  useEffect(() => {
    if (gate !== 'unlocked' || !active) return;
    if (view === 'hearth') {
      fbFetch('/fusebox/hearth')
        .then((r) => r.json())
        .then((d) => {
          if (d.ok && d.registry) setHearthReg(d.registry);
          else setHearthMsg({ ok: false, text: d.error ?? 'The hearth circuit is not answering.' });
        })
        .catch(() => setHearthMsg({ ok: false, text: 'The hearth circuit is not answering.' }));
      fbFetch('/fusebox/hearth/vacuums')
        .then((r) => r.json())
        .then((d) => {
          if (d.ok && d.vacuums) setVacRoster(d.vacuums);
          else setVacMsg({ ok: false, text: d.error ?? 'The vacuum roster is not answering.' });
        })
        .catch(() => setVacMsg({ ok: false, text: 'The vacuum roster is not answering.' }));
      fbFetch('/fusebox/hearth/audio')
        .then((r) => r.json())
        .then((d) => {
          if (d.ok && d.audio) setAudioRoster(d.audio);
          else setAudioMsg({ ok: false, text: d.error ?? 'The audio roster is not answering.' });
        })
        .catch(() => setAudioMsg({ ok: false, text: 'The audio roster is not answering.' }));
    }
    if (view === 'workshop') {
      fbFetch('/fusebox/workshop')
        .then((r) => r.json())
        .then((d) => {
          if (d.ok && d.mappings) setWsMappings(d.mappings);
          else setWsMsg({ ok: false, text: d.error ?? 'The workshop circuit is not answering.' });
        })
        .catch(() => setWsMsg({ ok: false, text: 'The workshop circuit is not answering.' }));
      fbFetch('/fusebox/workshop/blocks')
        .then((r) => r.json())
        .then((d) => {
          if (d.ok && Array.isArray(d.blocks)) setWsBlocks(d.blocks);
          else setBlocksMsg({ ok: false, text: d.error ?? 'The blocks are not answering.' });
        })
        .catch(() => setBlocksMsg({ ok: false, text: 'The blocks are not answering.' }));
    }
    if (view !== 'hearth') {
      setHearthMsg(null);
      setHaLights(null);
      setVacMsg(null);
      setAudioMsg(null);
      setHaMedia(null);
      setHaVacuums(null);
    }
    if (view !== 'workshop') {
      setWsMsg(null);
      setWsDatabases(null);
      setBlocksMsg(null);
      setSchemas({});
    }
  }, [view, gate, active]);

  const addSceneLight = useCallback((name: string) => {
    setHearthReg((r) => {
      if (!r || r.scene_lights.includes(name) || r.scene_lights.length >= 10) return r;
      return {
        ...r,
        scene_lights: [...r.scene_lights, name],
        scenes: r.scenes.map((s) => ({ ...s, values: [...s.values, 0] })),
      };
    });
  }, []);

  const removeSceneLight = useCallback((index: number) => {
    setHearthReg((r) => {
      if (!r || r.scene_lights.length <= 1) return r;
      return {
        ...r,
        scene_lights: r.scene_lights.filter((_, i) => i !== index),
        scenes: r.scenes.map((s) => ({ ...s, values: s.values.filter((_, i) => i !== index) })),
      };
    });
  }, []);

  const addScene = useCallback(() => {
    setHearthReg((r) => {
      if (!r || r.scenes.length >= 12) return r;
      return {
        ...r,
        scenes: [...r.scenes, { name: '', icon: 'ti-bulb', values: r.scene_lights.map(() => 0) }],
      };
    });
  }, []);

  const removeScene = useCallback((index: number) => {
    setHearthReg((r) => {
      if (!r || r.scenes.length <= 1) return r;
      return { ...r, scenes: r.scenes.filter((_, i) => i !== index) };
    });
  }, []);

  const fetchHaLights = useCallback(async () => {
    setHaLights(null);
    setHearthMsg({ ok: true, text: 'Asking the house what it has…' });
    try {
      const res = await fbFetch('/fusebox/hearth/available');
      const data = await res.json();
      if (data.ok) {
        setHaLights(data.lights);
        // The same read feeds the roster editors — one rail, one fetch.
        setHaMedia(data.media ?? null);
        setHaVacuums(data.vacuums ?? null);
        setHearthMsg(null);
      } else {
        setHearthMsg({ ok: false, text: data.error ?? 'HA did not answer.' });
      }
    } catch {
      setHearthMsg({ ok: false, text: 'HA did not answer.' });
    }
  }, []);

  const saveHearth = useCallback(async () => {
    if (!hearthReg || hearthBusy) return;
    setHearthBusy(true);
    setHearthMsg(null);
    try {
      const res = await fbFetch('/fusebox/hearth', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hearthReg),
      });
      const data = await res.json();
      setHearthMsg(
        data.ok
          ? { ok: true, text: 'Saved. The next scene tap and tonight’s goodnight use it.' }
          : { ok: false, text: data.error ?? 'Save failed.' },
      );
    } catch {
      setHearthMsg({ ok: false, text: 'Save failed — the panel is not answering.' });
    } finally {
      setHearthBusy(false);
    }
  }, [hearthReg, hearthBusy]);

  // ── Vacuum roster handlers ────────────────────────────────────────────────

  // The typed-area gate: a name only enters the roster once the rail confirms
  // the area exists (side-effect-free probe). Rail down reads as "couldn't
  // check", never as "invalid" — the server keeps those distinct.
  const addVacuumArea = useCallback(
    async (vi: number) => {
      const draft = (areaDrafts[vi] ?? '').trim();
      if (!draft || areaChecking !== null) return;
      const vac = vacRoster?.[vi];
      if (!vac) return;
      if (vac.areas.some((a) => a.toLowerCase() === draft.toLowerCase())) {
        setVacMsg({ ok: false, text: `${vac.name} already has "${draft}".` });
        return;
      }
      setAreaChecking(vi);
      setVacMsg({ ok: true, text: `Asking the house if "${draft}" exists…` });
      try {
        const res = await fbFetch('/fusebox/hearth/validate-area', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ area: draft }),
        });
        const data = await res.json();
        if (data.ok && data.valid) {
          setVacRoster((r) => {
            if (!r) return r;
            const next = [...r];
            next[vi] = { ...next[vi], areas: [...next[vi].areas, draft] };
            return next;
          });
          setAreaDrafts((d) => ({ ...d, [vi]: '' }));
          setVacMsg({ ok: true, text: `"${draft}" is real — added. Save to make it a chip.` });
        } else if (data.ok) {
          setVacMsg({ ok: false, text: data.reason ?? `The house has no area called "${draft}".` });
        } else {
          setVacMsg({ ok: false, text: data.error ?? "Couldn't check — the rail didn't answer." });
        }
      } catch {
        setVacMsg({ ok: false, text: "Couldn't check — the rail didn't answer." });
      } finally {
        setAreaChecking(null);
      }
    },
    [areaDrafts, areaChecking, vacRoster],
  );

  const saveVacuums = useCallback(async () => {
    if (!vacRoster || vacBusy) return;
    setVacBusy(true);
    setVacMsg(null);
    try {
      const res = await fbFetch('/fusebox/hearth/vacuums', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vacRoster),
      });
      const data = await res.json();
      setVacMsg(
        data.ok
          ? { ok: true, text: 'Saved. The Hearth chips follow on its next poll.' }
          : { ok: false, text: data.error ?? 'Save failed.' },
      );
    } catch {
      setVacMsg({ ok: false, text: 'Save failed — the panel is not answering.' });
    } finally {
      setVacBusy(false);
    }
  }, [vacRoster, vacBusy]);

  // ── Audio roster handlers ─────────────────────────────────────────────────

  // A fetched speaker lands under its HA area, creating the area row if this
  // is its first speaker — the two-level shape assembling itself.
  const addFetchedSpeaker = useCallback((name: string, area: string) => {
    setAudioRoster((r) => {
      if (!r) return r;
      const ai = r.areas.findIndex((a) => a.area.toLowerCase() === area.toLowerCase());
      if (ai === -1) return { ...r, areas: [...r.areas, { area, speakers: [name] }] };
      if (r.areas[ai].speakers.some((s) => s.toLowerCase() === name.toLowerCase())) return r;
      const areas = [...r.areas];
      areas[ai] = { ...areas[ai], speakers: [...areas[ai].speakers, name] };
      return { ...r, areas };
    });
  }, []);

  const saveAudio = useCallback(async () => {
    if (!audioRoster || audioBusy) return;
    setAudioBusy(true);
    setAudioMsg(null);
    try {
      const res = await fbFetch('/fusebox/hearth/audio', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(audioRoster),
      });
      const data = await res.json();
      setAudioMsg(
        data.ok
          ? { ok: true, text: 'Saved. The Hearth audio section follows on its next poll.' }
          : { ok: false, text: data.error ?? 'Save failed.' },
      );
    } catch {
      setAudioMsg({ ok: false, text: 'Save failed — the panel is not answering.' });
    } finally {
      setAudioBusy(false);
    }
  }, [audioRoster, audioBusy]);

  const fetchWsDatabases = useCallback(async () => {
    setWsDatabases(null);
    setWsMsg({ ok: true, text: 'Asking Notion what the token can see…' });
    try {
      const res = await fbFetch('/fusebox/workshop/databases');
      const data = await res.json();
      if (data.ok) {
        setWsDatabases(data.databases);
        setWsMsg(null);
      } else {
        setWsMsg({ ok: false, text: data.error ?? 'Notion did not answer.' });
      }
    } catch {
      setWsMsg({ ok: false, text: 'Notion did not answer.' });
    }
  }, []);

  // ── Generic-block builder handlers ────────────────────────────────────────

  // Per-source schema fetch: properties are ticked from what the source
  // actually has, never typed from memory. Unsupported types come back
  // flagged so the panel can show them greyed with their type named.
  const fetchSchema = useCallback(async (dsId: string) => {
    setSchemas((s) => ({ ...s, [dsId]: 'loading' }));
    try {
      const res = await fbFetch(`/fusebox/workshop/schema?id=${encodeURIComponent(dsId)}`);
      const data = await res.json();
      if (data.ok && Array.isArray(data.properties)) {
        setSchemas((s) => ({ ...s, [dsId]: data.properties }));
      } else {
        setSchemas((s) => {
          const rest = { ...s };
          delete rest[dsId];
          return rest;
        });
        setBlocksMsg({ ok: false, text: data.error ?? 'Notion did not answer with a schema.' });
      }
    } catch {
      setSchemas((s) => {
        const rest = { ...s };
        delete rest[dsId];
        return rest;
      });
      setBlocksMsg({ ok: false, text: 'Notion did not answer with a schema.' });
    }
  }, []);

  const patchBlock = useCallback((bi: number, patch: (b: WorkshopBlock) => WorkshopBlock) => {
    setWsBlocks((blocks) => {
      if (!blocks) return blocks;
      const next = [...blocks];
      next[bi] = patch(next[bi]);
      return next;
    });
  }, []);

  const saveBlocks = useCallback(async () => {
    if (!wsBlocks || blocksBusy) return;
    setBlocksBusy(true);
    setBlocksMsg(null);
    try {
      const res = await fbFetch('/fusebox/workshop/blocks', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wsBlocks),
      });
      const data = await res.json();
      setBlocksMsg(
        data.ok
          ? { ok: true, text: 'Saved. The Workshop grows the block on its next open — no deploy.' }
          : { ok: false, text: data.error ?? 'Save failed.' },
      );
    } catch {
      setBlocksMsg({ ok: false, text: 'Save failed — the panel is not answering.' });
    } finally {
      setBlocksBusy(false);
    }
  }, [wsBlocks, blocksBusy]);

  const saveWorkshop = useCallback(async () => {
    if (!wsMappings || wsBusy) return;
    setWsBusy(true);
    setWsMsg(null);
    try {
      const res = await fbFetch('/fusebox/workshop', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wsMappings),
      });
      const data = await res.json();
      setWsMsg(
        data.ok
          ? { ok: true, text: 'Saved. The Workshop reads the new mappings on its next fetch.' }
          : { ok: false, text: data.error ?? 'Save failed.' },
      );
    } catch {
      setWsMsg({ ok: false, text: 'Save failed — the panel is not answering.' });
    } finally {
      setWsBusy(false);
    }
  }, [wsMappings, wsBusy]);

  const runImport = useCallback(async () => {
    if (memBusy || !importText.trim()) return;
    let rows: unknown;
    try {
      rows = JSON.parse(importText);
    } catch {
      setImportReport('That is not valid JSON — expected an array of memory rows.');
      return;
    }
    setMemBusy(true);
    setImportReport('Importing — every row embeds on the way in…');
    try {
      const res = await fbFetch('/fusebox/memories/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      const data = await res.json();
      if (data.ok) {
        const failures = (data.failed as Array<{ index: number; title: string; error: string }>) ?? [];
        setImportReport(
          `Inserted ${data.inserted}.` +
            (failures.length
              ? ` Failed ${failures.length}: ${failures
                  .map((f) => `#${f.index} "${f.title}" (${f.error})`)
                  .join('; ')}`
              : ' No failures.'),
        );
        if (data.inserted > 0) {
          setImportText('');
          loadMemories();
        }
      } else {
        setImportReport(data.error ?? 'Import failed.');
      }
    } catch {
      setImportReport('Import failed — the panel is not answering.');
    } finally {
      setMemBusy(false);
    }
  }, [memBusy, importText, loadMemories]);

  // Ask the doorbell on every entry: the token may have lapsed since the
  // last visit, and status answers 200 whether locked or not.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    fbFetch('/fusebox/status')
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        setGate(data.unlocked ? 'unlocked' : 'locked');
        setRemaining(data.remaining_seconds ?? 0);
      })
      .catch(() => {
        if (!cancelled) setGate('locked');
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  // The re-lock countdown. Client-side mirror of the server TTL — cosmetic
  // (the server enforces regardless), but honest: at zero the panel locks
  // itself rather than pretending the next click would work.
  useEffect(() => {
    if (gate !== 'unlocked' || !active) return;
    const tick = setInterval(() => {
      setRemaining((s) => {
        if (s <= 1) {
          setGate('locked');
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [gate, active]);

  const unlock = useCallback(async () => {
    if (busy || !pw) return;
    setBusy(true);
    setErr('');
    try {
      const res = await fbFetch('/fusebox/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) {
        const data = await res.json();
        setGate('unlocked');
        setRemaining(data.ttl_seconds ?? 15 * 60);
        setPw('');
        return;
      }
      setErr('Wrong key.');
      setPw('');
      pwRef.current?.focus();
    } catch {
      setErr('The panel is not answering.');
    } finally {
      setBusy(false);
    }
  }, [busy, pw]);

  // ── Décor circuit state ───────────────────────────────────────────────────
  const [decorData, setDecorData] = useState<{
    versions: DecorVersionMeta[];
    registry: DecorRegistry;
  } | null>(null);
  const [decorErr, setDecorErr] = useState('');
  const [decorMsg, setDecorMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [decorBusy, setDecorBusy] = useState(false);
  // null = the theme list; a string = the editor, open on that theme name
  // ('' = a brand-new theme with no saved versions yet).
  const [themeOpen, setThemeOpen] = useState<string | null>(null);
  const [decorName, setDecorName] = useState('');
  const [decorDraft, setDecorDraft] = useState<DecorTokensDraft>({ colors: {}, fonts: {} });
  const [decorNote, setDecorNote] = useState('');
  // What the in-session preview is wearing: 'draft', a version id, or null.
  const [decorPreviewing, setDecorPreviewing] = useState<string | null>(null);
  const [confirmNeutral, setConfirmNeutral] = useState(false);
  const [decorImportText, setDecorImportText] = useState('');
  const [decorImportReport, setDecorImportReport] = useState<DecorImportReport | null>(null);

  const loadDecor = useCallback(async () => {
    setDecorErr('');
    try {
      const res = await fbFetch('/fusebox/decor');
      const data = await res.json();
      if (data.ok) setDecorData({ versions: data.versions, registry: data.registry });
      else setDecorErr(data.error ?? 'The décor circuit is not answering.');
    } catch {
      setDecorErr('The décor circuit is not answering.');
    }
  }, []);

  useEffect(() => {
    if (view === 'decor' && gate === 'unlocked' && active) loadDecor();
    if (view !== 'decor') {
      // Leaving the circuit drops the preview — it is session dressing, never
      // state — and resets the editor (service panel, not a draft box).
      setDecorPreview(null);
      setDecorPreviewing(null);
      setThemeOpen(null);
      setDecorMsg(null);
      setDecorImportReport(null);
      setDecorImportText('');
      setConfirmNeutral(false);
    }
  }, [view, gate, active, loadDecor]);

  // Resolve a slot through the draft, falling back to the compiled neutral —
  // the same resolution order the engine applies server-side.
  const decorResolved = useCallback(
    (slot: DecorSlot): DecorPair => decorDraft.colors[slot.key] ?? slot.neutral,
    [decorDraft],
  );

  // Build wearable CSS from the draft, client-side, for the in-session
  // preview. Emits from the server-sent registry, so the slot list can never
  // drift from the engine's.
  const decorDraftCss = useCallback((): string => {
    if (!decorData) return '';
    const stacks = Object.fromEntries(decorData.registry.font_options.map((f) => [f.key, f.stack]));
    const dark = decorData.registry.colors
      .map((s) => `--${s.key}: ${(decorDraft.colors[s.key] ?? s.neutral).dark};`)
      .join(' ');
    const type = decorData.registry.fonts
      .map((f) => `--${f.key}: ${stacks[decorDraft.fonts[f.key] ?? f.neutral]};`)
      .join(' ');
    return `:root { ${dark} ${type} }`;
  }, [decorData, decorDraft]);

  const setDecorSlot = useCallback(
    (slot: DecorSlot, side: 'dark' | 'light', value: string) => {
      setDecorDraft((d) => {
        const current = d.colors[slot.key] ?? slot.neutral;
        return { ...d, colors: { ...d.colors, [slot.key]: { ...current, [side]: value } } };
      });
    },
    [],
  );

  const clearDecorSlot = useCallback((key: string) => {
    setDecorDraft((d) => {
      const { [key]: _drop, ...rest } = d.colors;
      return { ...d, colors: rest };
    });
  }, []);

  // Open a theme in the editor. The basis version is the one the house wears
  // if this theme is active, else the newest — same answer the engine gives.
  const openDecorTheme = useCallback(
    async (name: string) => {
      if (!decorData) return;
      const of = decorData.versions.filter((v) => v.name === name);
      const basis = of.find((v) => v.is_active) ?? of[0];
      if (!basis) return;
      try {
        const res = await fbFetch(`/fusebox/decor/${basis.id}`);
        const data = await res.json();
        if (!data.ok) {
          setDecorMsg({ ok: false, text: data.error ?? 'Could not read that theme.' });
          return;
        }
        setDecorDraft(data.version.tokens);
        setDecorName(name);
        setDecorNote('');
        setThemeOpen(name);
        setDecorMsg(null);
        setDecorImportReport(null);
        setDecorImportText('');
      } catch {
        setDecorMsg({ ok: false, text: 'Could not read that theme — the panel is not answering.' });
      }
    },
    [decorData],
  );

  const newDecorTheme = useCallback(() => {
    setDecorDraft({ colors: {}, fonts: {} });
    setDecorName('');
    setDecorNote('');
    setThemeOpen('');
    setDecorMsg(null);
    setDecorImportReport(null);
    setDecorImportText('');
  }, []);

  const saveDecor = useCallback(async () => {
    if (decorBusy || !decorName.trim()) return;
    setDecorBusy(true);
    setDecorMsg(null);
    try {
      const res = await fbFetch('/fusebox/decor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: decorName, tokens: decorDraft, note: decorNote }),
      });
      const data = await res.json();
      if (data.ok) {
        setDecorMsg({
          ok: true,
          text: 'Saved as a new version. If this theme is what the house wears, it is live now.',
        });
        setDecorNote('');
        setThemeOpen(decorName.trim());
        window.dispatchEvent(new Event(DECOR_CHANGED_EVENT));
        loadDecor();
      } else {
        setDecorMsg({ ok: false, text: data.error ?? 'Save failed.' });
      }
    } catch {
      setDecorMsg({ ok: false, text: 'Save failed — the panel is not answering.' });
    } finally {
      setDecorBusy(false);
    }
  }, [decorBusy, decorName, decorDraft, decorNote, loadDecor]);

  // Activate/restore — one verb, one mechanism: the house wears this version.
  const wearDecorVersion = useCallback(
    async (id: string) => {
      if (decorBusy) return;
      setDecorBusy(true);
      setDecorMsg(null);
      try {
        const res = await fbFetch(`/fusebox/decor/${id}/activate`, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          setDecorMsg({ ok: true, text: 'The house wears it. Live everywhere — no deploy.' });
          setDecorPreview(null);
          setDecorPreviewing(null);
          window.dispatchEvent(new Event(DECOR_CHANGED_EVENT));
          loadDecor();
        } else {
          setDecorMsg({ ok: false, text: data.error ?? 'Activate failed.' });
        }
      } catch {
        setDecorMsg({ ok: false, text: 'Activate failed — the panel is not answering.' });
      } finally {
        setDecorBusy(false);
      }
    },
    [decorBusy, loadDecor],
  );

  const wearNeutral = useCallback(async () => {
    if (decorBusy) return;
    setDecorBusy(true);
    setDecorMsg(null);
    try {
      const res = await fbFetch('/fusebox/decor/deactivate', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        setDecorMsg({ ok: true, text: 'No theme active — the house wears the neutral default.' });
        setConfirmNeutral(false);
        window.dispatchEvent(new Event(DECOR_CHANGED_EVENT));
        loadDecor();
      } else {
        setDecorMsg({ ok: false, text: data.error ?? 'Deactivate failed.' });
      }
    } catch {
      setDecorMsg({ ok: false, text: 'Deactivate failed — the panel is not answering.' });
    } finally {
      setDecorBusy(false);
    }
  }, [decorBusy, loadDecor]);

  const previewDecorDraft = useCallback(() => {
    setDecorPreview(decorDraftCss());
    setDecorPreviewing('draft');
  }, [decorDraftCss]);

  const previewDecorVersion = useCallback(
    async (id: string) => {
      if (decorPreviewing === id) {
        setDecorPreview(null);
        setDecorPreviewing(null);
        return;
      }
      try {
        const res = await fbFetch(`/fusebox/decor/${id}`);
        const data = await res.json();
        if (data.ok) {
          setDecorPreview(data.version.css);
          setDecorPreviewing(id);
        }
      } catch {
        /* preview is best-effort */
      }
    },
    [decorPreviewing],
  );

  const exitDecorPreview = useCallback(() => {
    setDecorPreview(null);
    setDecorPreviewing(null);
  }, []);

  const parseDecorPaste = useCallback(async () => {
    if (decorBusy || !decorImportText.trim()) return;
    setDecorBusy(true);
    setDecorMsg(null);
    setDecorImportReport(null);
    try {
      const res = await fbFetch('/fusebox/decor/import-parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: decorImportText }),
      });
      const data = await res.json();
      if (data.ok) setDecorImportReport(data.report);
      else setDecorMsg({ ok: false, text: data.error ?? 'Could not read that paste.' });
    } catch {
      setDecorMsg({ ok: false, text: 'Could not read that paste — the panel is not answering.' });
    } finally {
      setDecorBusy(false);
    }
  }, [decorBusy, decorImportText]);

  // Import never partially applies: the whole mapping lands in the draft in
  // one confirmed step, and nothing is stored until Save commits it.
  const applyDecorImport = useCallback(() => {
    if (!decorImportReport) return;
    setDecorDraft((d) => ({
      colors: {
        ...d.colors,
        ...Object.fromEntries(
          Object.entries(decorImportReport.colors).map(([k, v]) => [k, { dark: v.dark, light: v.light }]),
        ),
      },
      fonts: {
        ...d.fonts,
        ...Object.fromEntries(Object.entries(decorImportReport.fonts).map(([k, v]) => [k, v.pick])),
      },
    }));
    setDecorImportReport(null);
    setDecorImportText('');
    setDecorMsg({
      ok: true,
      text: 'Mapped into the draft. Nothing is saved yet — review the slots, then save.',
    });
  }, [decorImportReport]);

  const mm = Math.floor(remaining / 60);
  const ss = String(remaining % 60).padStart(2, '0');

  return (
    <div className="fusebox">
      {gate === 'checking' && <div className="fusebox__checking">Checking the lock…</div>}

      {gate === 'locked' && (
        <div className="fusebox__gate">
          <div className="fusebox__gatecard">
            <i className="ti ti-bolt fusebox__gateicon" aria-hidden="true" />
            <div className="fusebox__gatetitle">The Fuse Box</div>
            <div className="fusebox__gatehint">
              Same key as the house. The panel asks again.
            </div>
            <input
              ref={pwRef}
              type="password"
              className="fusebox__pw"
              placeholder="Password"
              autoComplete="current-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') unlock();
              }}
            />
            <button className="fusebox__open" onClick={unlock} disabled={busy || !pw}>
              {busy ? 'Checking…' : 'Open the panel'}
            </button>
            <div className="fusebox__err">{err}</div>
          </div>
        </div>
      )}

      {gate === 'unlocked' && (
        <div className="fusebox__board">
          <div className="fusebox__head">
            <div>
              <div className="fusebox__title">{VIEW_META[view].title}</div>
              <div className="fusebox__sub">{VIEW_META[view].sub}</div>
            </div>
            <div className="fusebox__ttl" title="The side gate re-locks; the server enforces it either way.">
              <i className="ti ti-lock" aria-hidden="true" /> re-locks in {mm}:{ss}
            </div>
          </div>

          {view === 'board' && (
            <>
              <div className="fusebox__grid">
                {CIRCUITS.map((c) => (
                  <div
                    key={c.name}
                    className={`fusebox__circuit ${c.wired ? 'fusebox__circuit--live' : 'fusebox__circuit--dead'}`}
                    onClick={() => {
                      if (c.wired && c.view) setView(c.view);
                    }}
                    role={c.wired ? 'button' : undefined}
                  >
                    <div className="fusebox__circuithead">
                      <i className={`ti ${c.icon}`} aria-hidden="true" />
                      <span className="fusebox__circuitname">{c.name}</span>
                      {!c.wired && <span className="fusebox__deadtag">not wired</span>}
                    </div>
                    <div className="fusebox__circuitblurb">{c.blurb}</div>
                  </div>
                ))}
              </div>

              <div className="fusebox__foot">
                Circuits go live in build order. Dashed means not wired yet.
              </div>
            </>
          )}

          {view === 'keys' && (
            <div className="fusebox__keys">
              <button className="fusebox__back" onClick={() => setView('board')}>
                <i className="ti ti-arrow-left" aria-hidden="true" /> board
              </button>

              {keysErr && <div className="fusebox__keyserr">{keysErr}</div>}
              {!keys && !keysErr && <div className="fusebox__checking">Reading the registry…</div>}

              {keys?.map((k) => (
                <div key={k.name} className="fusebox__keyrow">
                  <div className="fusebox__keymain">
                    <span
                      className={`fusebox__keydot ${k.set ? 'fusebox__keydot--set' : ''}`}
                      title={k.set ? 'Set in the Secrets Store' : 'Not in the Secrets Store yet'}
                    />
                    <div className="fusebox__keyid">
                      <span className="fusebox__keyname">{k.name}</span>
                      <span className="fusebox__keyconsumer">{k.consumer}</span>
                    </div>
                    <span className="fusebox__keymeta">
                      {k.set
                        ? k.modified
                          ? `updated ${agoLabel(new Date(k.modified).getTime())}`
                          : 'set'
                        : 'not set'}
                    </span>
                    <div className="fusebox__keyactions">
                      {k.testable && (
                        <button
                          className="fusebox__keybtn"
                          disabled={keyBusy !== null}
                          onClick={() => runTest(k.name)}
                        >
                          Test
                        </button>
                      )}
                      <button
                        className="fusebox__keybtn fusebox__keybtn--primary"
                        disabled={keyBusy !== null}
                        onClick={() => {
                          setRotating(rotating === k.name ? null : k.name);
                          setDraft('');
                        }}
                      >
                        {k.set ? 'Rotate' : 'Set'}
                      </button>
                    </div>
                  </div>

                  {rotating === k.name && (
                    <div className="fusebox__keyedit">
                      <input
                        type="password"
                        className="fusebox__keyinput"
                        placeholder={`New ${k.name} value`}
                        value={draft}
                        autoFocus
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveDraft(k.name);
                          if (e.key === 'Escape') setRotating(null);
                        }}
                      />
                      <button
                        className="fusebox__keybtn fusebox__keybtn--primary"
                        disabled={!draft.trim() || keyBusy !== null}
                        onClick={() => saveDraft(k.name)}
                      >
                        {keyBusy === k.name ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  )}

                  {keyNotes[k.name] && (
                    <div
                      className={`fusebox__keynote ${keyNotes[k.name].ok ? '' : 'fusebox__keynote--bad'}`}
                    >
                      {keyNotes[k.name].text}
                    </div>
                  )}
                </div>
              ))}

              <div className="fusebox__foot">
                Tests run against the value the house actually runs on — the Secrets Store
                binding. Rotation is live on the next call; no deploy.
              </div>
            </div>
          )}

          {view === 'identity' && (
            <div className="fusebox__identity">
              <button className="fusebox__back" onClick={() => setView('board')}>
                <i className="ti ti-arrow-left" aria-hidden="true" /> board
              </button>

              {promptErr && <div className="fusebox__keyserr">{promptErr}</div>}
              {!promptData && !promptErr && (
                <div className="fusebox__checking">Reading the identity circuit…</div>
              )}

              {promptData && (
                <>
                  <div className="fusebox__seclabel">Static core prompt</div>
                  <textarea
                    className="fusebox__editor"
                    value={promptDraft}
                    spellCheck={false}
                    onChange={(e) => setPromptDraft(e.target.value)}
                  />
                  <div className="fusebox__editmeta">
                    <span>
                      {promptDraft.length.toLocaleString()} chars · ≈{Math.round(promptDraft.length / 3.7).toLocaleString()} tokens
                    </span>
                    <span className="fusebox__edithint">
                      {promptData.active && promptDraft === promptData.active.content
                        ? 'unchanged from the active version'
                        : 'edited — save to make it live'}
                    </span>
                  </div>
                  <div className="fusebox__saverow">
                    <input
                      className="fusebox__keyinput"
                      placeholder="Version note (optional — why this change)"
                      value={draftNote}
                      onChange={(e) => setDraftNote(e.target.value)}
                    />
                    <button
                      className="fusebox__keybtn fusebox__keybtn--primary"
                      disabled={
                        identityBusy ||
                        !promptDraft.trim() ||
                        (promptData.active !== null && promptDraft === promptData.active.content)
                      }
                      onClick={savePrompt}
                    >
                      {identityBusy ? 'Working…' : 'Save as new version'}
                    </button>
                  </div>
                  {promptMsg && (
                    <div className={`fusebox__keynote ${promptMsg.ok ? '' : 'fusebox__keynote--bad'}`}>
                      {promptMsg.text}
                    </div>
                  )}

                  <div className="fusebox__seclabel">Versions</div>
                  {promptData.versions.map((v) => (
                    <div key={v.id} className="fusebox__keyrow">
                      <div className="fusebox__keymain">
                        <span
                          className={`fusebox__keydot ${v.is_active ? 'fusebox__keydot--set' : ''}`}
                          title={v.is_active ? `Active — this is what ${houseIdentity.companion_name} runs on` : 'History'}
                        />
                        <div className="fusebox__keyid">
                          <span className="fusebox__keyname">
                            {new Date(v.created_at).toLocaleString('en-AU', {
                              timeZone: 'Australia/Perth',
                              day: 'numeric',
                              month: 'short',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                            {v.is_active && <span className="fusebox__activetag">ACTIVE</span>}
                          </span>
                          <span className="fusebox__keyconsumer">
                            {v.note ?? 'no note'} · {v.chars.toLocaleString()} chars
                          </span>
                        </div>
                        <div className="fusebox__keyactions">
                          <button className="fusebox__keybtn" onClick={() => togglePreview(v.id)}>
                            {preview?.id === v.id ? 'Hide' : 'Preview'}
                          </button>
                          {!v.is_active && (
                            <button
                              className="fusebox__keybtn fusebox__keybtn--primary"
                              disabled={identityBusy}
                              onClick={() => restoreVersion(v.id)}
                            >
                              Restore
                            </button>
                          )}
                        </div>
                      </div>
                      {preview?.id === v.id && (
                        <pre className="fusebox__preview">{preview.content}</pre>
                      )}
                    </div>
                  ))}

                  <div className="fusebox__seclabel">Voice</div>
                  <div className="fusebox__voicerow">
                    <input
                      className="fusebox__keyinput"
                      placeholder="ElevenLabs voice id"
                      value={voiceId}
                      onChange={(e) => setVoiceId(e.target.value)}
                    />
                    <input
                      className="fusebox__keyinput fusebox__voicemodel"
                      placeholder="Model id"
                      value={modelId}
                      onChange={(e) => setModelId(e.target.value)}
                    />
                    <button
                      className="fusebox__keybtn fusebox__keybtn--primary"
                      disabled={identityBusy || !voiceId.trim() || !modelId.trim()}
                      onClick={saveVoice}
                    >
                      Save
                    </button>
                    <button className="fusebox__keybtn" disabled={identityBusy} onClick={validateVoice}>
                      Validate
                    </button>
                  </div>
                  <div className="fusebox__foot">
                    Validate checks the SAVED voice id against the ElevenLabs account — save
                    first, then validate. The next voice note uses whatever is saved here.
                  </div>
                  {voiceMsg && (
                    <div className={`fusebox__keynote ${voiceMsg.ok ? '' : 'fusebox__keynote--bad'}`}>
                      {voiceMsg.text}
                    </div>
                  )}

                  <div className="fusebox__seclabel">The names</div>
                  <div className="fusebox__foot">
                    Who lives here — the house, the companion, you. Every surface
                    (composer, bubbles, labels, the launcher) follows a save with
                    no deploy.
                  </div>
                  <div className="fusebox__voicerow">
                    <input
                      className="fusebox__keyinput"
                      placeholder="House name"
                      value={profileDraft.house_name}
                      onChange={(e) =>
                        setProfileDraft((d) => ({ ...d, house_name: e.target.value }))
                      }
                    />
                    <input
                      className="fusebox__keyinput"
                      placeholder="Companion's name"
                      value={profileDraft.companion_name}
                      onChange={(e) =>
                        setProfileDraft((d) => ({ ...d, companion_name: e.target.value }))
                      }
                    />
                    <input
                      className="fusebox__keyinput"
                      placeholder="Your name"
                      value={profileDraft.user_name}
                      onChange={(e) =>
                        setProfileDraft((d) => ({ ...d, user_name: e.target.value }))
                      }
                    />
                  </div>
                  <div className="fusebox__voicerow">
                    <input
                      className="fusebox__keyinput"
                      placeholder="Relationship word (husband, companion…)"
                      value={profileDraft.companion_role}
                      onChange={(e) =>
                        setProfileDraft((d) => ({ ...d, companion_role: e.target.value }))
                      }
                    />
                    <input
                      className="fusebox__keyinput"
                      placeholder="Timezone (Australia/Perth)"
                      value={profileDraft.timezone}
                      onChange={(e) =>
                        setProfileDraft((d) => ({ ...d, timezone: e.target.value }))
                      }
                    />
                    <button
                      className="fusebox__keybtn fusebox__keybtn--primary"
                      disabled={
                        identityBusy ||
                        !profileDraft.house_name.trim() ||
                        !profileDraft.companion_name.trim() ||
                        !profileDraft.user_name.trim()
                      }
                      onClick={saveProfile}
                    >
                      Save
                    </button>
                  </div>
                  {profileMsg && (
                    <div className={`fusebox__keynote ${profileMsg.ok ? '' : 'fusebox__keynote--bad'}`}>
                      {profileMsg.text}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {view === 'memories' && (
            <div className="fusebox__memories">
              <button className="fusebox__back" onClick={() => setView('board')}>
                <i className="ti ti-arrow-left" aria-hidden="true" /> board
              </button>

              {/* §9's counter — the named defence against the spine quietly
                  bloating every call. Not decoration. */}
              {memSpine && (
                <div className="fusebox__spine">
                  <i className="ti ti-backbone" aria-hidden="true" />
                  {memSpine.core_count ?? '?'} core · {memSpine.always_on_count} always-on rows ·
                  ≈{memSpine.always_on_count ? memSpine.approx_tokens.toLocaleString() : 0} tokens on every call
                </div>
              )}

              <div className="fusebox__memfilters">
                <select
                  className="fusebox__select"
                  value={memFilters.type}
                  onChange={(e) => setMemFilters((f) => ({ ...f, type: e.target.value }))}
                >
                  <option value="">all types</option>
                  {MEM_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <select
                  className="fusebox__select"
                  value={memFilters.category}
                  onChange={(e) => setMemFilters((f) => ({ ...f, category: e.target.value }))}
                >
                  <option value="">all categories</option>
                  {MEM_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <select
                  className="fusebox__select"
                  value={memFilters.core}
                  onChange={(e) => setMemFilters((f) => ({ ...f, core: e.target.value }))}
                >
                  <option value="">core + non</option>
                  <option value="core">core only</option>
                  <option value="non">non-core</option>
                </select>
                <select
                  className="fusebox__select"
                  value={memFilters.active}
                  onChange={(e) => setMemFilters((f) => ({ ...f, active: e.target.value }))}
                >
                  <option value="active">active</option>
                  <option value="archived">archived</option>
                  <option value="all">all</option>
                </select>
                <input
                  className="fusebox__keyinput fusebox__memsearch"
                  placeholder="Search title & content"
                  value={memFilters.q}
                  onChange={(e) => setMemFilters((f) => ({ ...f, q: e.target.value }))}
                />
                <button className="fusebox__keybtn fusebox__keybtn--primary" onClick={() => openMemForm(null)}>
                  Add
                </button>
                <button className="fusebox__keybtn" onClick={() => setImportOpen((o) => !o)}>
                  Import
                </button>
              </div>

              {importOpen && (
                <div className="fusebox__import">
                  <textarea
                    className="fusebox__editor fusebox__importbox"
                    placeholder='JSON array: [{"title","content","type","category","tags"?,"entry_date"?,"core"?,"active"?,"created_at"?}, …] — max 200 rows per batch'
                    value={importText}
                    spellCheck={false}
                    onChange={(e) => setImportText(e.target.value)}
                  />
                  <div className="fusebox__saverow">
                    <span className="fusebox__edithint">
                      Every row embeds on the way in — a bad row is reported by index, never fatal.
                    </span>
                    <button
                      className="fusebox__keybtn fusebox__keybtn--primary"
                      disabled={memBusy || !importText.trim()}
                      onClick={runImport}
                    >
                      {memBusy ? 'Importing…' : 'Run import'}
                    </button>
                  </div>
                  {importReport && <div className="fusebox__keynote">{importReport}</div>}
                </div>
              )}

              {memForm && (
                <div className="fusebox__memform">
                  <div className="fusebox__seclabel">
                    {memForm.id ? 'Edit memory' : 'New memory'}
                  </div>
                  <input
                    className="fusebox__keyinput"
                    placeholder="Title"
                    value={memForm.title}
                    onChange={(e) => setMemForm((f) => f && { ...f, title: e.target.value })}
                  />
                  <textarea
                    className="fusebox__editor fusebox__memcontent"
                    placeholder="Content"
                    value={memForm.content}
                    spellCheck={false}
                    onChange={(e) => setMemForm((f) => f && { ...f, content: e.target.value })}
                  />
                  <div className="fusebox__memformrow">
                    <select
                      className="fusebox__select"
                      value={memForm.type}
                      onChange={(e) => setMemForm((f) => f && { ...f, type: e.target.value })}
                    >
                      {MEM_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                    <select
                      className="fusebox__select"
                      value={memForm.category}
                      onChange={(e) => setMemForm((f) => f && { ...f, category: e.target.value })}
                    >
                      {MEM_CATEGORIES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                    {(memForm.type === 'daily' || memForm.type === 'weekly') && (
                      <input
                        type="date"
                        className="fusebox__keyinput"
                        value={memForm.entry_date}
                        onChange={(e) => setMemForm((f) => f && { ...f, entry_date: e.target.value })}
                      />
                    )}
                    <input
                      className="fusebox__keyinput"
                      placeholder="tags, comma, separated"
                      value={memForm.tags}
                      onChange={(e) => setMemForm((f) => f && { ...f, tags: e.target.value })}
                    />
                  </div>
                  <div className="fusebox__memformrow">
                    <label className="fusebox__check">
                      <input
                        type="checkbox"
                        checked={memForm.core}
                        onChange={(e) => setMemForm((f) => f && { ...f, core: e.target.checked })}
                      />
                      core (rides every call)
                    </label>
                    <label className="fusebox__check">
                      <input
                        type="checkbox"
                        checked={memForm.active}
                        onChange={(e) => setMemForm((f) => f && { ...f, active: e.target.checked })}
                      />
                      active
                    </label>
                    <span className="fusebox__memformspacer" />
                    <button className="fusebox__keybtn" onClick={() => setMemForm(null)}>
                      Cancel
                    </button>
                    <button
                      className="fusebox__keybtn fusebox__keybtn--primary"
                      disabled={memBusy || !memForm.title.trim() || !memForm.content.trim()}
                      onClick={saveMemForm}
                    >
                      {memBusy ? 'Saving…' : memForm.id ? 'Save' : 'Add memory'}
                    </button>
                  </div>
                </div>
              )}

              {memMsg && (
                <div className={`fusebox__keynote ${memMsg.ok ? '' : 'fusebox__keynote--bad'}`}>
                  {memMsg.text}
                </div>
              )}
              {memErr && <div className="fusebox__keyserr">{memErr}</div>}
              {!memRows && !memErr && <div className="fusebox__checking">Reading the spine…</div>}

              {memRows?.map((m) => (
                <div key={m.id} className={`fusebox__keyrow ${m.active ? '' : 'fusebox__memrow--archived'}`}>
                  <div className="fusebox__keymain">
                    <span
                      className={`fusebox__keydot ${m.core ? 'fusebox__keydot--core' : m.active ? 'fusebox__keydot--set' : ''}`}
                      title={m.core ? 'Core — rides every call' : m.active ? 'Active' : 'Archived'}
                    />
                    <div className="fusebox__keyid">
                      <span className="fusebox__memtitle">{m.title}</span>
                      <span className="fusebox__keyconsumer">
                        {m.type} · {m.category}
                        {m.entry_date ? ` · ${m.entry_date}` : ''}
                        {m.tags?.length ? ` · ${m.tags.join(', ')}` : ''}
                      </span>
                    </div>
                    <span className="fusebox__keymeta">
                      {m.updated_at ? agoLabel(new Date(m.updated_at).getTime()) : ''}
                    </span>
                    <div className="fusebox__keyactions">
                      <button className="fusebox__keybtn" disabled={memBusy} onClick={() => openMemForm(m)}>
                        Edit
                      </button>
                      <button className="fusebox__keybtn" disabled={memBusy} onClick={() => toggleMemActive(m)}>
                        {m.active ? 'Archive' : 'Restore'}
                      </button>
                      <button
                        className={`fusebox__keybtn ${memArmed === m.id ? 'fusebox__keybtn--armed' : ''}`}
                        disabled={memBusy}
                        onClick={() => deleteMem(m)}
                      >
                        {memArmed === m.id ? 'Sure?' : 'Delete'}
                      </button>
                    </div>
                  </div>
                  <div className="fusebox__memcontentline">{m.content}</div>
                </div>
              ))}
              {memRows && memRows.length === 0 && (
                <div className="fusebox__checking">Nothing matches these filters.</div>
              )}
            </div>
          )}

          {view === 'references' && (
            <div className="fusebox__refs">
              <button className="fusebox__back" onClick={() => setView('board')}>
                <i className="ti ti-arrow-left" aria-hidden="true" /> board
              </button>

              <div className="fusebox__memfilters">
                <span className="fusebox__edithint">
                  Descriptions are what the render pass weaves into prompts — canon lives here.
                </span>
                <span className="fusebox__memformspacer" />
                <button
                  className="fusebox__keybtn fusebox__keybtn--primary"
                  onClick={() =>
                    setRefForm({
                      id: null,
                      slug: '',
                      kind: 'character',
                      display_name: '',
                      description: '',
                      active: true,
                    })
                  }
                >
                  Add reference
                </button>
              </div>

              {refForm && (
                <div className="fusebox__memform">
                  <div className="fusebox__seclabel">
                    {refForm.id ? `Edit ${refForm.slug}` : 'New reference'}
                  </div>
                  <div className="fusebox__memformrow">
                    <input
                      className="fusebox__keyinput"
                      placeholder="slug (immutable, e.g. elle-wrist-tattoo)"
                      value={refForm.slug}
                      disabled={refForm.id !== null}
                      onChange={(e) => setRefForm((f) => f && { ...f, slug: e.target.value })}
                    />
                    <select
                      className="fusebox__select"
                      value={refForm.kind}
                      onChange={(e) =>
                        setRefForm((f) => f && { ...f, kind: e.target.value as 'character' | 'location' })
                      }
                    >
                      <option value="character">character</option>
                      <option value="location">location</option>
                    </select>
                    <input
                      className="fusebox__keyinput"
                      placeholder="Display name"
                      value={refForm.display_name}
                      onChange={(e) => setRefForm((f) => f && { ...f, display_name: e.target.value })}
                    />
                  </div>
                  <textarea
                    className="fusebox__editor fusebox__memcontent"
                    placeholder="Description — the prose canon the render pass reads"
                    value={refForm.description}
                    spellCheck={false}
                    onChange={(e) => setRefForm((f) => f && { ...f, description: e.target.value })}
                  />
                  <div className="fusebox__memformrow">
                    <input ref={refFileRef} type="file" accept="image/png,image/jpeg,image/webp" className="fusebox__file" />
                    <span className="fusebox__edithint">
                      {refForm.id ? 'leave empty to keep the current image' : `required · max ${REF_MAX_MB} MiB`}
                    </span>
                    <span className="fusebox__memformspacer" />
                    <label className="fusebox__check">
                      <input
                        type="checkbox"
                        checked={refForm.active}
                        onChange={(e) => setRefForm((f) => f && { ...f, active: e.target.checked })}
                      />
                      active
                    </label>
                    <button className="fusebox__keybtn" onClick={() => setRefForm(null)}>
                      Cancel
                    </button>
                    <button
                      className="fusebox__keybtn fusebox__keybtn--primary"
                      disabled={
                        refBusy ||
                        !refForm.slug.trim() ||
                        !refForm.display_name.trim() ||
                        !refForm.description.trim()
                      }
                      onClick={saveRef}
                    >
                      {refBusy ? 'Uploading…' : refForm.id ? 'Save' : 'Create'}
                    </button>
                  </div>
                </div>
              )}

              {refMsg && (
                <div className={`fusebox__keynote ${refMsg.ok ? '' : 'fusebox__keynote--bad'}`}>
                  {refMsg.text}
                </div>
              )}
              {refErr && <div className="fusebox__keyserr">{refErr}</div>}
              {!refRows && !refErr && <div className="fusebox__checking">Reading the bank…</div>}

              {refRows?.map((r) => (
                <div key={r.id} className={`fusebox__keyrow ${r.active ? '' : 'fusebox__memrow--archived'}`}>
                  <div className="fusebox__keymain">
                    <img
                      className="fusebox__refthumb"
                      src={apiUrl(`/gallery/file/${r.storage_path}`)}
                      alt={r.display_name}
                      loading="lazy"
                    />
                    <div className="fusebox__keyid">
                      <span className="fusebox__memtitle">
                        {r.display_name}
                        <span className="fusebox__refslug">{r.slug}</span>
                      </span>
                      <span className="fusebox__keyconsumer">{r.kind}</span>
                    </div>
                    <div className="fusebox__keyactions">
                      <button
                        className="fusebox__keybtn"
                        disabled={refBusy}
                        onClick={() =>
                          setRefForm({
                            id: r.id,
                            slug: r.slug,
                            kind: r.kind,
                            display_name: r.display_name,
                            description: r.description,
                            active: r.active,
                          })
                        }
                      >
                        Edit
                      </button>
                      <button className="fusebox__keybtn" disabled={refBusy} onClick={() => toggleRefActive(r)}>
                        {r.active ? 'Hide' : 'Show'}
                      </button>
                      <button
                        className={`fusebox__keybtn ${refArmed === r.id ? 'fusebox__keybtn--armed' : ''}`}
                        disabled={refBusy}
                        onClick={() => deleteRef(r)}
                      >
                        {refArmed === r.id ? 'Sure?' : 'Delete'}
                      </button>
                    </div>
                  </div>
                  <div className="fusebox__memcontentline">{r.description}</div>
                </div>
              ))}
              {refRows && refRows.length === 0 && (
                <div className="fusebox__checking">The bank is empty — add the first face.</div>
              )}
            </div>
          )}

          {view === 'hearth' && (
            <div className="fusebox__hearth">
              <button className="fusebox__back" onClick={() => setView('board')}>
                <i className="ti ti-arrow-left" aria-hidden="true" /> board
              </button>

              {!hearthReg && <div className="fusebox__checking">Reading the registry…</div>}

              {hearthReg && (
                <>
                  <div className="fusebox__seclabel">Scene lights (order matters)</div>
                  {hearthReg.scene_lights.map((name, i) => (
                    <div key={i} className="fusebox__memformrow fusebox__lightrow">
                      <input
                        className="fusebox__keyinput"
                        value={name}
                        onChange={(e) =>
                          setHearthReg((r) => {
                            if (!r) return r;
                            const lights = [...r.scene_lights];
                            lights[i] = e.target.value;
                            return { ...r, scene_lights: lights };
                          })
                        }
                      />
                      <button
                        className="fusebox__keybtn"
                        disabled={hearthReg.scene_lights.length <= 1}
                        onClick={() => removeSceneLight(i)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <div className="fusebox__memformrow">
                    <button className="fusebox__keybtn" onClick={fetchHaLights}>
                      Fetch from HA
                    </button>
                    <span className="fusebox__edithint">
                      what this house actually exposes — click to add
                    </span>
                  </div>
                  {haLights && (
                    <div className="fusebox__halights">
                      {haLights.map((l) => (
                        <button
                          key={l.name}
                          className="fusebox__keybtn"
                          disabled={hearthReg.scene_lights.includes(l.name)}
                          onClick={() => addSceneLight(l.name)}
                        >
                          + {l.name}
                          {l.area ? ` (${l.area})` : ''}
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="fusebox__seclabel">
                    Scenes (each is a chip in the Hearth; 0–100 per light, in order)
                  </div>
                  <div className="fusebox__scenes">
                    <div className="fusebox__scenerow fusebox__scenerow--head">
                      <span />
                      <span className="fusebox__sceneicon" />
                      {hearthReg.scene_lights.map((n, i) => (
                        <span key={i} className="fusebox__scenelight">{n}</span>
                      ))}
                      <span />
                    </div>
                    {hearthReg.scenes.map((scene, si) => (
                      <div key={si} className="fusebox__scenerow">
                        <input
                          className="fusebox__scenename fusebox__scenenameinput"
                          placeholder="Name"
                          value={scene.name}
                          onChange={(e) =>
                            setHearthReg((r) => {
                              if (!r) return r;
                              const scenes = [...r.scenes];
                              scenes[si] = { ...scenes[si], name: e.target.value };
                              return { ...r, scenes };
                            })
                          }
                        />
                        <select
                          className="fusebox__select fusebox__sceneicon"
                          value={scene.icon}
                          onChange={(e) =>
                            setHearthReg((r) => {
                              if (!r) return r;
                              const scenes = [...r.scenes];
                              scenes[si] = { ...scenes[si], icon: e.target.value };
                              return { ...r, scenes };
                            })
                          }
                        >
                          {[...new Set([scene.icon, ...SCENE_ICONS])].map((ic) => (
                            <option key={ic} value={ic}>{ic.replace('ti-', '')}</option>
                          ))}
                        </select>
                        {scene.values.map((v, i) => (
                          <input
                            key={i}
                            type="number"
                            min={0}
                            max={100}
                            className="fusebox__sceneval"
                            value={v}
                            onChange={(e) =>
                              setHearthReg((r) => {
                                if (!r) return r;
                                const scenes = [...r.scenes];
                                const values = [...scenes[si].values];
                                values[i] = Number(e.target.value);
                                scenes[si] = { ...scenes[si], values };
                                return { ...r, scenes };
                              })
                            }
                          />
                        ))}
                        <button
                          className="fusebox__keybtn"
                          disabled={hearthReg.scenes.length <= 1}
                          onClick={() => removeScene(si)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <div className="fusebox__scenerow">
                      <button
                        className="fusebox__keybtn"
                        disabled={hearthReg.scenes.length >= 12}
                        onClick={addScene}
                      >
                        + Add scene
                      </button>
                    </div>
                  </div>

                  <div className="fusebox__seclabel">Goodnight</div>
                  <div className="fusebox__memformrow">
                    <input
                      className="fusebox__keyinput"
                      placeholder="Path-to-bed light name"
                      value={hearthReg.goodnight.light}
                      onChange={(e) =>
                        setHearthReg((r) => r && { ...r, goodnight: { ...r.goodnight, light: e.target.value } })
                      }
                    />
                    <input
                      type="number"
                      min={0}
                      max={100}
                      className="fusebox__sceneval"
                      value={hearthReg.goodnight.brightness}
                      onChange={(e) =>
                        setHearthReg(
                          (r) =>
                            r && { ...r, goodnight: { ...r.goodnight, brightness: Number(e.target.value) } },
                        )
                      }
                    />
                    <span className="fusebox__edithint">% after everything else goes dark</span>
                    <span className="fusebox__memformspacer" />
                    <button
                      className="fusebox__keybtn fusebox__keybtn--primary"
                      disabled={hearthBusy}
                      onClick={saveHearth}
                    >
                      {hearthBusy ? 'Saving…' : 'Save registry'}
                    </button>
                  </div>
                  {hearthMsg && (
                    <div className={`fusebox__keynote ${hearthMsg.ok ? '' : 'fusebox__keynote--bad'}`}>
                      {hearthMsg.text}
                    </div>
                  )}
                </>
              )}

              {/* ── Vacuum roster (18 Jul extension) ─────────────────────── */}
              <div className="fusebox__seclabel">
                Vacuums (each one's clean-a-room chips in the Hearth)
              </div>
              {!vacRoster && <div className="fusebox__checking">Reading the vacuum roster…</div>}
              {vacRoster && (
                <>
                  {vacRoster.map((vac, vi) => (
                    <div key={vi} className="fusebox__roster">
                      <div className="fusebox__memformrow fusebox__lightrow">
                        <input
                          className="fusebox__keyinput"
                          value={vac.name}
                          onChange={(e) =>
                            setVacRoster((r) => {
                              if (!r) return r;
                              const next = [...r];
                              next[vi] = { ...next[vi], name: e.target.value };
                              return next;
                            })
                          }
                        />
                        <button
                          className="fusebox__keybtn"
                          disabled={vacRoster.length <= 1}
                          onClick={() => setVacRoster((r) => r && r.filter((_, i) => i !== vi))}
                        >
                          Remove
                        </button>
                      </div>
                      <div className="fusebox__halights">
                        {vac.areas.map((a) => (
                          <button
                            key={a}
                            className="fusebox__keybtn"
                            title="Remove — the chip leaves the Hearth on save"
                            onClick={() =>
                              setVacRoster((r) => {
                                if (!r) return r;
                                const next = [...r];
                                next[vi] = { ...next[vi], areas: next[vi].areas.filter((x) => x !== a) };
                                return next;
                              })
                            }
                          >
                            {a} ×
                          </button>
                        ))}
                        {vac.areas.length === 0 && (
                          <span className="fusebox__edithint">no areas yet — whole-house clean only</span>
                        )}
                      </div>
                      <div className="fusebox__memformrow">
                        <input
                          className="fusebox__keyinput"
                          placeholder="Add an area (e.g. Study)"
                          value={areaDrafts[vi] ?? ''}
                          onChange={(e) => setAreaDrafts((d) => ({ ...d, [vi]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void addVacuumArea(vi);
                          }}
                        />
                        <button
                          className="fusebox__keybtn"
                          disabled={areaChecking !== null || !(areaDrafts[vi] ?? '').trim()}
                          onClick={() => void addVacuumArea(vi)}
                        >
                          {areaChecking === vi ? 'Checking…' : 'Check & add'}
                        </button>
                      </div>
                    </div>
                  ))}
                  {haVacuums && (
                    <div className="fusebox__halights">
                      {haVacuums.map((v) => (
                        <button
                          key={v.name}
                          className="fusebox__keybtn"
                          disabled={
                            vacRoster.some((x) => x.name.toLowerCase() === v.name.toLowerCase()) ||
                            vacRoster.length >= 4
                          }
                          onClick={() => setVacRoster((r) => r && [...r, { name: v.name, areas: [] }])}
                        >
                          + {v.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="fusebox__memformrow">
                    <button className="fusebox__keybtn" onClick={fetchHaLights}>
                      Fetch from HA
                    </button>
                    <span className="fusebox__edithint">
                      HA can't list a vacuum's rooms — type each area; it's checked against the
                      house before it's accepted
                    </span>
                    <span className="fusebox__memformspacer" />
                    <button
                      className="fusebox__keybtn fusebox__keybtn--primary"
                      disabled={vacBusy}
                      onClick={saveVacuums}
                    >
                      {vacBusy ? 'Saving…' : 'Save vacuums'}
                    </button>
                  </div>
                </>
              )}
              {vacMsg && (
                <div className={`fusebox__keynote ${vacMsg.ok ? '' : 'fusebox__keynote--bad'}`}>
                  {vacMsg.text}
                </div>
              )}

              {/* ── Audio roster (18 Jul extension) ──────────────────────── */}
              <div className="fusebox__seclabel">
                Audio (by area — a room can hold several speakers; Everywhere stays its own group)
              </div>
              {!audioRoster && <div className="fusebox__checking">Reading the audio roster…</div>}
              {audioRoster && (
                <>
                  <div className="fusebox__memformrow">
                    <input
                      className="fusebox__keyinput"
                      placeholder="Everywhere group player (blank for none)"
                      value={audioRoster.everywhere ?? ''}
                      onChange={(e) =>
                        setAudioRoster((r) => r && { ...r, everywhere: e.target.value || null })
                      }
                    />
                    <span className="fusebox__edithint">
                      the all-speakers group — sits above the areas, never inside one
                    </span>
                  </div>
                  {audioRoster.areas.map((a, ai) => (
                    <div key={ai} className="fusebox__memformrow fusebox__lightrow">
                      <span className="fusebox__rosterarea">{a.area}</span>
                      <div className="fusebox__halights fusebox__halights--inline">
                        {a.speakers.map((s) => (
                          <button
                            key={s}
                            className="fusebox__keybtn"
                            title="Remove — an area with no speakers leaves the roster"
                            onClick={() =>
                              setAudioRoster((r) => {
                                if (!r) return r;
                                const areas = r.areas
                                  .map((x, i) =>
                                    i === ai
                                      ? { ...x, speakers: x.speakers.filter((y) => y !== s) }
                                      : x,
                                  )
                                  .filter((x) => x.speakers.length > 0);
                                return { ...r, areas };
                              })
                            }
                          >
                            {s} ×
                          </button>
                        ))}
                      </div>
                      <input
                        className="fusebox__keyinput"
                        placeholder="Add speaker"
                        value={speakerDrafts[ai] ?? ''}
                        onChange={(e) => setSpeakerDrafts((d) => ({ ...d, [ai]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (speakerDrafts[ai] ?? '').trim()) {
                            addFetchedSpeaker((speakerDrafts[ai] ?? '').trim(), a.area);
                            setSpeakerDrafts((d) => ({ ...d, [ai]: '' }));
                          }
                        }}
                      />
                      <button
                        className="fusebox__keybtn"
                        disabled={!(speakerDrafts[ai] ?? '').trim()}
                        onClick={() => {
                          addFetchedSpeaker((speakerDrafts[ai] ?? '').trim(), a.area);
                          setSpeakerDrafts((d) => ({ ...d, [ai]: '' }));
                        }}
                      >
                        Add
                      </button>
                    </div>
                  ))}
                  <div className="fusebox__memformrow">
                    <input
                      className="fusebox__keyinput"
                      placeholder="New area"
                      value={newAreaDraft}
                      onChange={(e) => setNewAreaDraft(e.target.value)}
                    />
                    <input
                      className="fusebox__keyinput"
                      placeholder="Its first speaker"
                      value={newSpeakerDraft}
                      onChange={(e) => setNewSpeakerDraft(e.target.value)}
                    />
                    <button
                      className="fusebox__keybtn"
                      disabled={!newAreaDraft.trim() || !newSpeakerDraft.trim()}
                      onClick={() => {
                        addFetchedSpeaker(newSpeakerDraft.trim(), newAreaDraft.trim());
                        setNewAreaDraft('');
                        setNewSpeakerDraft('');
                      }}
                    >
                      + Add area
                    </button>
                    <span className="fusebox__edithint">an area exists by holding a speaker</span>
                  </div>
                  {haMedia && (
                    <div className="fusebox__halights">
                      {haMedia
                        .filter((m) => m.area !== null)
                        .map((m) => (
                          <button
                            key={m.name}
                            className="fusebox__keybtn"
                            disabled={audioRoster.areas.some((a) =>
                              a.speakers.some((s) => s.toLowerCase() === m.name.toLowerCase()),
                            )}
                            onClick={() => addFetchedSpeaker(m.name, m.area as string)}
                          >
                            + {m.name} ({m.area})
                          </button>
                        ))}
                      {haMedia
                        .filter((m) => m.area === null)
                        .map((m) => (
                          <button
                            key={m.name}
                            className="fusebox__keybtn"
                            disabled={audioRoster.everywhere === m.name}
                            onClick={() =>
                              setAudioRoster((r) => r && { ...r, everywhere: m.name })
                            }
                          >
                            {m.name} → Everywhere
                          </button>
                        ))}
                    </div>
                  )}
                  <div className="fusebox__memformrow">
                    <button className="fusebox__keybtn" onClick={fetchHaLights}>
                      Fetch from HA
                    </button>
                    <span className="fusebox__edithint">
                      speakers arrive with their HA area — no area on a player marks it as a
                      whole-house group
                    </span>
                    <span className="fusebox__memformspacer" />
                    <button
                      className="fusebox__keybtn fusebox__keybtn--primary"
                      disabled={audioBusy}
                      onClick={saveAudio}
                    >
                      {audioBusy ? 'Saving…' : 'Save audio'}
                    </button>
                  </div>
                </>
              )}
              {audioMsg && (
                <div className={`fusebox__keynote ${audioMsg.ok ? '' : 'fusebox__keynote--bad'}`}>
                  {audioMsg.text}
                </div>
              )}
            </div>
          )}

          {view === 'workshop' && (
            <div className="fusebox__workshop">
              <button className="fusebox__back" onClick={() => setView('board')}>
                <i className="ti ti-arrow-left" aria-hidden="true" /> board
              </button>

              {!wsMappings && <div className="fusebox__checking">Reading the mappings…</div>}

              {wsMappings && (
                <>
                  {MAPPING_FIELDS.map((f) => (
                    <div key={f.key} className="fusebox__memformrow fusebox__wsrow">
                      <span className="fusebox__wslabel">{f.label}</span>
                      <input
                        className="fusebox__keyinput fusebox__wsid"
                        value={wsMappings[f.key] ?? ''}
                        spellCheck={false}
                        onChange={(e) =>
                          setWsMappings((m) => m && { ...m, [f.key]: e.target.value })
                        }
                      />
                    </div>
                  ))}
                  <div className="fusebox__memformrow">
                    <button className="fusebox__keybtn" onClick={fetchWsDatabases}>
                      List data sources the token can see
                    </button>
                    <span className="fusebox__memformspacer" />
                    <button
                      className="fusebox__keybtn fusebox__keybtn--primary"
                      disabled={wsBusy}
                      onClick={saveWorkshop}
                    >
                      {wsBusy ? 'Saving…' : 'Save mappings'}
                    </button>
                  </div>
                  {wsDatabases && (
                    <div className="fusebox__wspicker">
                      {wsDatabases.map((d) => (
                        <div key={d.id} className="fusebox__memformrow fusebox__wsrow">
                          <span className="fusebox__wslabel">{d.title}</span>
                          <span className="fusebox__wsidtext">{d.id}</span>
                          {(['journal_ds', 'tasks_ds', 'projects_ds'] as const).map((slot) => (
                            <button
                              key={slot}
                              className="fusebox__keybtn"
                              onClick={() => setWsMappings((m) => m && { ...m, [slot]: d.id })}
                            >
                              → {slot.replace('_ds', '')}
                            </button>
                          ))}
                        </div>
                      ))}
                      {wsDatabases.length === 0 && (
                        <div className="fusebox__checking">The token sees no data sources.</div>
                      )}
                    </div>
                  )}
                  {wsMsg && (
                    <div className={`fusebox__keynote ${wsMsg.ok ? '' : 'fusebox__keynote--bad'}`}>
                      {wsMsg.text}
                    </div>
                  )}
                  <div className="fusebox__foot">
                    Page ids (the HQ root, the workspace root) come from Notion&apos;s copy-link —
                    the picker lists data sources only. Consumers read these per call:
                    a repoint is live on the next fetch.
                  </div>
                </>
              )}

              {/* ── Generic parent blocks (18 Jul extension) ─────────────── */}
              <div className="fusebox__seclabel">
                Parent blocks (composable — one or more sources, one sorted list)
              </div>
              {!wsBlocks && <div className="fusebox__checking">Reading the blocks…</div>}
              {wsBlocks && (
                <>
                  {wsBlocks.map((block, bi) => {
                    const tickedUnion = [
                      'title',
                      ...new Set(block.sources.flatMap((s) => s.properties)),
                    ];
                    return (
                      <div key={bi} className="fusebox__roster">
                        <div className="fusebox__memformrow fusebox__lightrow">
                          <input
                            className="fusebox__keyinput"
                            placeholder="Block name (e.g. Assessments)"
                            value={block.name}
                            onChange={(e) => patchBlock(bi, (b) => ({ ...b, name: e.target.value }))}
                          />
                          <select
                            className="fusebox__select"
                            value={block.icon}
                            onChange={(e) => patchBlock(bi, (b) => ({ ...b, icon: e.target.value }))}
                          >
                            {[...new Set([block.icon, ...BLOCK_ICONS])].map((ic) => (
                              <option key={ic} value={ic}>{ic.replace('ti-', '')}</option>
                            ))}
                          </select>
                          <button
                            className="fusebox__keybtn"
                            onClick={() => setWsBlocks((bs) => bs && bs.filter((_, i) => i !== bi))}
                          >
                            Remove block
                          </button>
                        </div>

                        {block.sources.map((src, si) => {
                          const dsTitle =
                            wsDatabases?.find((d) => d.id === src.data_source_id)?.title ??
                            `${src.data_source_id.slice(0, 8)}…`;
                          const schema = schemas[src.data_source_id];
                          return (
                            <div key={src.data_source_id} className="fusebox__blocksrc">
                              <div className="fusebox__memformrow fusebox__lightrow">
                                <span className="fusebox__rosterarea" title={src.data_source_id}>
                                  {dsTitle}
                                </span>
                                <select
                                  className="fusebox__select"
                                  value={src.accent}
                                  onChange={(e) =>
                                    patchBlock(bi, (b) => ({
                                      ...b,
                                      sources: b.sources.map((s, i) =>
                                        i === si ? { ...s, accent: e.target.value } : s,
                                      ),
                                    }))
                                  }
                                >
                                  {VDS_ACCENTS.map((a) => (
                                    <option key={a} value={a}>{a}</option>
                                  ))}
                                </select>
                                <span
                                  className={`fusebox__accentdot fusebox__accentdot--${src.accent}`}
                                  aria-hidden="true"
                                />
                                <button
                                  className="fusebox__keybtn"
                                  disabled={schema === 'loading'}
                                  onClick={() => void fetchSchema(src.data_source_id)}
                                >
                                  {schema === 'loading' ? 'Fetching…' : 'Fetch properties'}
                                </button>
                                <button
                                  className="fusebox__keybtn"
                                  onClick={() =>
                                    patchBlock(bi, (b) => ({
                                      ...b,
                                      sources: b.sources.filter((_, i) => i !== si),
                                    }))
                                  }
                                >
                                  ×
                                </button>
                              </div>
                              {Array.isArray(schema) ? (
                                <div className="fusebox__halights">
                                  {schema.map((p) => (
                                    <button
                                      key={p.name}
                                      className={`fusebox__keybtn ${src.properties.includes(p.name) ? 'fusebox__keybtn--primary' : ''}`}
                                      disabled={!p.supported}
                                      title={p.supported ? p.type : `${p.type} — renders as "—"`}
                                      onClick={() =>
                                        patchBlock(bi, (b) => ({
                                          ...b,
                                          sources: b.sources.map((s, i) =>
                                            i === si
                                              ? {
                                                  ...s,
                                                  properties: s.properties.includes(p.name)
                                                    ? s.properties.filter((x) => x !== p.name)
                                                    : [...s.properties, p.name],
                                                }
                                              : s,
                                          ),
                                        }))
                                      }
                                    >
                                      {p.name}
                                      {!p.supported && ` (${p.type})`}
                                    </button>
                                  ))}
                                </div>
                              ) : (
                                src.properties.length > 0 && (
                                  <div className="fusebox__halights">
                                    {src.properties.map((p) => (
                                      <span key={p} className="fusebox__keybtn" aria-disabled="true">
                                        {p}
                                      </span>
                                    ))}
                                  </div>
                                )
                              )}
                            </div>
                          );
                        })}

                        {wsDatabases ? (
                          <div className="fusebox__halights">
                            {wsDatabases
                              .filter((d) => !block.sources.some((s) => s.data_source_id === d.id))
                              .map((d) => (
                                <button
                                  key={d.id}
                                  className="fusebox__keybtn"
                                  disabled={block.sources.length >= 4}
                                  onClick={() =>
                                    patchBlock(bi, (b) => ({
                                      ...b,
                                      sources: [
                                        ...b.sources,
                                        {
                                          data_source_id: d.id,
                                          accent:
                                            VDS_ACCENTS.find(
                                              (a) => !b.sources.some((s) => s.accent === a),
                                            ) ?? 'teal',
                                          properties: [],
                                        },
                                      ],
                                    }))
                                  }
                                >
                                  + {d.title}
                                </button>
                              ))}
                          </div>
                        ) : (
                          <div className="fusebox__memformrow">
                            <button className="fusebox__keybtn" onClick={fetchWsDatabases}>
                              List data sources the token can see
                            </button>
                            <span className="fusebox__edithint">to add sources to this block</span>
                          </div>
                        )}

                        <div className="fusebox__memformrow">
                          <span className="fusebox__edithint">sorted by</span>
                          <select
                            className="fusebox__select"
                            value={block.sort.property}
                            onChange={(e) =>
                              patchBlock(bi, (b) => ({
                                ...b,
                                sort: { ...b.sort, property: e.target.value },
                              }))
                            }
                          >
                            {[...new Set([block.sort.property, ...tickedUnion])].map((p) => (
                              <option key={p} value={p}>{p}</option>
                            ))}
                          </select>
                          <select
                            className="fusebox__select"
                            value={block.sort.direction}
                            onChange={(e) =>
                              patchBlock(bi, (b) => ({
                                ...b,
                                sort: {
                                  ...b.sort,
                                  direction: e.target.value === 'desc' ? 'desc' : 'asc',
                                },
                              }))
                            }
                          >
                            <option value="asc">ascending</option>
                            <option value="desc">descending</option>
                          </select>
                          <span className="fusebox__edithint">
                            one merged list — source shows as the tile&apos;s accent bar
                          </span>
                        </div>
                      </div>
                    );
                  })}

                  <div className="fusebox__memformrow">
                    <button
                      className="fusebox__keybtn"
                      disabled={wsBlocks.length >= 8}
                      onClick={() =>
                        setWsBlocks((bs) =>
                          bs && [
                            ...bs,
                            {
                              name: '',
                              icon: 'ti-database',
                              sources: [],
                              sort: { property: 'title', direction: 'asc' as const },
                            },
                          ],
                        )
                      }
                    >
                      + Add block
                    </button>
                    <span className="fusebox__edithint">
                      read-only tiles; five property types render, the rest show an honest —
                    </span>
                    <span className="fusebox__memformspacer" />
                    <button
                      className="fusebox__keybtn fusebox__keybtn--primary"
                      disabled={blocksBusy}
                      onClick={saveBlocks}
                    >
                      {blocksBusy ? 'Saving…' : 'Save blocks'}
                    </button>
                  </div>
                </>
              )}
              {blocksMsg && (
                <div className={`fusebox__keynote ${blocksMsg.ok ? '' : 'fusebox__keynote--bad'}`}>
                  {blocksMsg.text}
                </div>
              )}
            </div>
          )}

          {view === 'decor' && (
            <div className="fusebox__decor">
              <button
                className="fusebox__back"
                onClick={() => {
                  if (themeOpen !== null) {
                    exitDecorPreview();
                    setThemeOpen(null);
                    setDecorMsg(null);
                  } else {
                    setView('board');
                  }
                }}
              >
                <i className="ti ti-arrow-left" aria-hidden="true" />{' '}
                {themeOpen !== null ? 'themes' : 'board'}
              </button>

              {decorPreviewing && (
                <div className="fusebox__dpreviewbar">
                  <i className="ti ti-eye" aria-hidden="true" /> Previewing in this window only —
                  the house still wears its saved décor.
                  <button className="fusebox__keybtn" onClick={exitDecorPreview}>
                    Exit preview
                  </button>
                </div>
              )}

              {decorErr && <div className="fusebox__keyserr">{decorErr}</div>}
              {!decorData && !decorErr && (
                <div className="fusebox__checking">Reading the décor circuit…</div>
              )}

              {decorData && themeOpen === null && (
                <>
                  <div className="fusebox__seclabel">Wearing</div>
                  {(() => {
                    const worn = decorData.versions.find((v) => v.is_active);
                    return (
                      <div className="fusebox__keyrow">
                        <div className="fusebox__keymain">
                          <span
                            className={`fusebox__keydot ${worn ? 'fusebox__keydot--set' : ''}`}
                            title={worn ? 'A theme is active' : 'Neutral default'}
                          />
                          <div className="fusebox__keyid">
                            <span className="fusebox__keyname">
                              {worn ? worn.name : 'Neutral default'}
                              {worn && <span className="fusebox__activetag">ACTIVE</span>}
                            </span>
                            <span className="fusebox__keyconsumer">
                              {worn
                                ? `version of ${decorWhen(worn.created_at)}${worn.note ? ` · ${worn.note}` : ''}`
                                : 'no theme active — the compiled-in primed wall'}
                            </span>
                          </div>
                          {worn && (
                            <div className="fusebox__keyactions">
                              {confirmNeutral ? (
                                <>
                                  <button
                                    className="fusebox__keybtn"
                                    onClick={() => setConfirmNeutral(false)}
                                  >
                                    Keep it
                                  </button>
                                  <button
                                    className="fusebox__keybtn fusebox__keybtn--primary"
                                    disabled={decorBusy}
                                    onClick={wearNeutral}
                                  >
                                    Yes — bare walls
                                  </button>
                                </>
                              ) : (
                                <button
                                  className="fusebox__keybtn"
                                  onClick={() => setConfirmNeutral(true)}
                                >
                                  Wear neutral
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  <div className="fusebox__seclabel">Themes</div>
                  {[...new Set(decorData.versions.map((v) => v.name))].map((name) => {
                    const of = decorData.versions.filter((v) => v.name === name);
                    const isWorn = of.some((v) => v.is_active);
                    return (
                      <div key={name} className="fusebox__keyrow">
                        <div className="fusebox__keymain">
                          <span
                            className={`fusebox__keydot ${isWorn ? 'fusebox__keydot--set' : ''}`}
                          />
                          <div className="fusebox__keyid">
                            <span className="fusebox__keyname">
                              {name}
                              {isWorn && <span className="fusebox__activetag">ACTIVE</span>}
                            </span>
                            <span className="fusebox__keyconsumer">
                              {of.length} version{of.length === 1 ? '' : 's'} · newest{' '}
                              {decorWhen(of[0].created_at)}
                            </span>
                          </div>
                          <div className="fusebox__keyactions">
                            {!isWorn && (
                              <button
                                className="fusebox__keybtn"
                                disabled={decorBusy}
                                onClick={() => wearDecorVersion(of[0].id)}
                              >
                                Wear
                              </button>
                            )}
                            <button
                              className="fusebox__keybtn fusebox__keybtn--primary"
                              onClick={() => openDecorTheme(name)}
                            >
                              Open
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {decorData.versions.length === 0 && (
                    <div className="fusebox__keyconsumer">
                      No themes yet — the house wears the neutral default. Add one, or paste a
                      token file into a new theme.
                    </div>
                  )}

                  <div className="fusebox__saverow">
                    <button className="fusebox__keybtn fusebox__keybtn--primary" onClick={newDecorTheme}>
                      + New theme
                    </button>
                  </div>

                  <div className="fusebox__seclabel">Deploy-bound, honestly</div>
                  <div className="fusebox__dnotes">
                    <div>
                      These cannot follow a runtime theme change — they apply on the next deploy,
                      or are deliberately outside the theme:
                    </div>
                    <ul>
                      <li>
                        PWA manifest colours (launch splash, install-time status bar) — baked at
                        build; a themed install wears the neutral splash until a deploy.
                      </li>
                      <li>Launcher icons, favicons and the app logo — brand artwork, not tokens.</li>
                      <li>
                        The login page and the connector gate page — outside the theme by house
                        rule (auth stays untouched).
                      </li>
                      <li>
                        Post Box label & category dots — room content, pinned on purpose; the
                        label roster is a future circuit.
                      </li>
                      <li>Notion option pills — an external system's palette, kept recognisable.</li>
                      <li>The email canvas stays white by design; link colour follows the theme.</li>
                    </ul>
                  </div>
                </>
              )}

              {decorData && themeOpen !== null && (
                <>
                  <div className="fusebox__seclabel">Theme</div>
                  <div className="fusebox__saverow">
                    <input
                      className="fusebox__keyinput"
                      placeholder="Theme name (saving under a new name starts a new theme)"
                      value={decorName}
                      onChange={(e) => setDecorName(e.target.value)}
                    />
                    <button
                      className="fusebox__keybtn"
                      onClick={() =>
                        decorPreviewing === 'draft' ? exitDecorPreview() : previewDecorDraft()
                      }
                    >
                      {decorPreviewing === 'draft' ? 'Exit preview' : 'Preview draft'}
                    </button>
                  </div>

                  {/* Live swatch strip — the draft, worn by a miniature room. */}
                  {(() => {
                    const get = (key: string, side: 'dark' | 'light' = 'dark') => {
                      const slot = decorData.registry.colors.find((s) => s.key === key);
                      return slot ? decorResolved(slot)[side] : '#000000';
                    };
                    return (
                      <div
                        className="fusebox__dstrip"
                        style={{ background: get('bg'), borderColor: get('bd') }}
                      >
                        <div
                          className="fusebox__dstripcard"
                          style={{ background: get('surface'), borderColor: get('bd') }}
                        >
                          <span style={{ color: get('tx') }}>Primary text</span>
                          <span style={{ color: get('tx2') }}>secondary</span>
                          <span style={{ color: get('tx3') }}>muted</span>
                        </div>
                        <span className="fusebox__dchip" style={{ background: get('teal'), color: get('pure') }}>
                          primary
                        </span>
                        <span
                          className="fusebox__dchip"
                          style={{ background: get('teal-300'), color: get('teal-ink') }}
                        >
                          chip
                        </span>
                        <span className="fusebox__dchip" style={{ background: get('bronze'), color: get('bronze-ink') }}>
                          warm
                        </span>
                        <span style={{ color: get('sage') }}>sage</span>
                        <span style={{ color: get('red') }}>alarm</span>
                        <span style={{ color: get('amber') }}>warn</span>
                      </div>
                    );
                  })()}

                  <div className="fusebox__seclabel">Type</div>
                  <div className="fusebox__voicerow">
                    {decorData.registry.fonts.map((f) => (
                      <label key={f.key} className="fusebox__dfont">
                        <span className="fusebox__keyconsumer">
                          {f.label} <span className="fusebox__dslotkey">--{f.key}</span>
                        </span>
                        <select
                          className="fusebox__keyinput"
                          value={decorDraft.fonts[f.key] ?? ''}
                          onChange={(e) =>
                            setDecorDraft((d) => {
                              const fonts = { ...d.fonts };
                              if (e.target.value) fonts[f.key] = e.target.value;
                              else delete fonts[f.key];
                              return { ...d, fonts };
                            })
                          }
                        >
                          <option value="">neutral ({f.neutral})</option>
                          {decorData.registry.font_options.map((o) => (
                            <option key={o.key} value={o.key}>
                              {o.key}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>

                  {[...new Set(decorData.registry.colors.map((s) => s.group))].map((group) => (
                    <div key={group}>
                      <div className="fusebox__seclabel">{group}</div>
                      {decorData.registry.colors
                        .filter((s) => s.group === group)
                        .map((slot) => {
                          const worn = decorResolved(slot);
                          const isSet = slot.key in decorDraft.colors;
                          return (
                            <div key={slot.key} className="fusebox__dslot">
                              <div className="fusebox__keyid">
                                <span className="fusebox__keyname">{slot.label}</span>
                                <span className="fusebox__keyconsumer">
                                  <span className="fusebox__dslotkey">--{slot.key}</span>
                                  {!isSet && ' · wears neutral'}
                                </span>
                              </div>
                              <label className="fusebox__dside">
                                <span>dark</span>
                                <input
                                  type="color"
                                  value={worn.dark}
                                  onChange={(e) => setDecorSlot(slot, 'dark', e.target.value.toUpperCase())}
                                />
                                <span className="fusebox__dhex">{worn.dark}</span>
                              </label>
                              <label className="fusebox__dside">
                                <span>light</span>
                                <input
                                  type="color"
                                  value={worn.light}
                                  onChange={(e) => setDecorSlot(slot, 'light', e.target.value.toUpperCase())}
                                />
                                <span className="fusebox__dhex">{worn.light}</span>
                              </label>
                              {isSet && (
                                <button
                                  className="fusebox__keybtn"
                                  title="Clear — fall back to neutral"
                                  onClick={() => clearDecorSlot(slot.key)}
                                >
                                  ×
                                </button>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  ))}

                  <div className="fusebox__saverow">
                    <input
                      className="fusebox__keyinput"
                      placeholder="Version note (optional — why this change)"
                      value={decorNote}
                      onChange={(e) => setDecorNote(e.target.value)}
                    />
                    <button
                      className="fusebox__keybtn fusebox__keybtn--primary"
                      disabled={decorBusy || !decorName.trim()}
                      onClick={saveDecor}
                    >
                      {decorBusy ? 'Working…' : 'Save as new version'}
                    </button>
                  </div>
                  {decorMsg && (
                    <div className={`fusebox__keynote ${decorMsg.ok ? '' : 'fusebox__keynote--bad'}`}>
                      {decorMsg.text}
                    </div>
                  )}

                  <div className="fusebox__seclabel">Import — paste a token file</div>
                  <textarea
                    className="fusebox__editor fusebox__dimport"
                    placeholder={
                      ':root-style CSS custom properties (a design-system token file is already this shape). Nothing applies until you confirm the mapping, and nothing is stored until you save.'
                    }
                    spellCheck={false}
                    value={decorImportText}
                    onChange={(e) => setDecorImportText(e.target.value)}
                  />
                  <div className="fusebox__saverow">
                    <button
                      className="fusebox__keybtn fusebox__keybtn--primary"
                      disabled={decorBusy || !decorImportText.trim()}
                      onClick={parseDecorPaste}
                    >
                      Read the paste
                    </button>
                  </div>
                  {decorImportReport && (
                    <div className="fusebox__dreport">
                      <div className="fusebox__keyconsumer">
                        Recognised {Object.keys(decorImportReport.colors).length} colour slot
                        {Object.keys(decorImportReport.colors).length === 1 ? '' : 's'} and{' '}
                        {Object.keys(decorImportReport.fonts).length} font pick
                        {Object.keys(decorImportReport.fonts).length === 1 ? '' : 's'}
                        {decorImportReport.modes === 'single' &&
                          ' — one mode in the paste, filling both light and dark'}
                        .
                      </div>
                      {Object.entries(decorImportReport.colors).map(([key, v]) => (
                        <div key={key} className="fusebox__dmaprow">
                          <span className="fusebox__dswatch" style={{ background: v.dark }} />
                          <span className="fusebox__dswatch" style={{ background: v.light }} />
                          <span className="fusebox__dslotkey">--{key}</span>
                          <span className="fusebox__keyconsumer">← {v.source}</span>
                        </div>
                      ))}
                      {Object.entries(decorImportReport.fonts).map(([key, v]) => (
                        <div key={key} className="fusebox__dmaprow">
                          <i className="ti ti-typography" aria-hidden="true" />
                          <span className="fusebox__dslotkey">--{key}</span>
                          <span className="fusebox__keyconsumer">
                            ← {v.source} → {v.pick}
                          </span>
                        </div>
                      ))}
                      {decorImportReport.unmapped.length > 0 && (
                        <div className="fusebox__keyconsumer">
                          Nothing recognised for: {decorImportReport.unmapped.join(', ')}
                        </div>
                      )}
                      {decorImportReport.unfilled.length > 0 && (
                        <div className="fusebox__keyconsumer">
                          Wearing neutral (not in the paste):{' '}
                          {decorImportReport.unfilled.map((k: string) => `--${k}`).join(', ')}
                        </div>
                      )}
                      <div className="fusebox__saverow">
                        <button className="fusebox__keybtn" onClick={() => setDecorImportReport(null)}>
                          Discard
                        </button>
                        <button
                          className="fusebox__keybtn fusebox__keybtn--primary"
                          onClick={applyDecorImport}
                        >
                          Apply mapping to draft
                        </button>
                      </div>
                    </div>
                  )}

                  {themeOpen !== '' && (
                    <>
                      <div className="fusebox__seclabel">Versions</div>
                      {decorData.versions
                        .filter((v) => v.name === themeOpen)
                        .map((v) => (
                          <div key={v.id} className="fusebox__keyrow">
                            <div className="fusebox__keymain">
                              <span
                                className={`fusebox__keydot ${v.is_active ? 'fusebox__keydot--set' : ''}`}
                                title={v.is_active ? 'The house wears this version' : 'History'}
                              />
                              <div className="fusebox__keyid">
                                <span className="fusebox__keyname">
                                  {decorWhen(v.created_at)}
                                  {v.is_active && <span className="fusebox__activetag">ACTIVE</span>}
                                </span>
                                <span className="fusebox__keyconsumer">{v.note ?? 'no note'}</span>
                              </div>
                              <div className="fusebox__keyactions">
                                <button
                                  className="fusebox__keybtn"
                                  onClick={() => previewDecorVersion(v.id)}
                                >
                                  {decorPreviewing === v.id ? 'Hide' : 'Preview'}
                                </button>
                                {!v.is_active && (
                                  <button
                                    className="fusebox__keybtn fusebox__keybtn--primary"
                                    disabled={decorBusy}
                                    onClick={() => wearDecorVersion(v.id)}
                                  >
                                    Restore
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                    </>
                  )}

                  <div className="fusebox__foot">
                    Every save is a new version; restore is one click; history is kept. A missing
                    slot wears the neutral default — a bad paste can never brick the walls.
                  </div>
                </>
              )}

              {decorMsg && themeOpen === null && (
                <div className={`fusebox__keynote ${decorMsg.ok ? '' : 'fusebox__keynote--bad'}`}>
                  {decorMsg.text}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
