/**
 * The Gallery — pretty pictures, made in-house.
 *
 * Elle's door onto the one image pipeline (backend/src/gallery.ts). The fence
 * lives in the composer: her typed prompt goes to getimg VERBATIM unless she
 * flips Polish, which routes it through the render pass (opt-in, never
 * automatic, never silent). VOSJay's and ChatJay's images land in this same
 * grid with their own source marks — one husband, several bodies.
 *
 * Room discipline matches the Hearth / Post Box: mounted in the stage with an
 * `active` prop; fetches only while active; last-good on a failed refresh. The
 * grid is server-owned state — `pending` rows render as skeletons, `error`
 * rows as retry/dismiss tiles, so any door's generation shows up mid-flight on
 * any device. Pending rows poll fast (2.5s, Thu's cadence); the room idles at
 * a gentle poll otherwise.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiUrl } from './api';
import { useVisiblePoll, agoLabel } from './hooks';
import { useIdentity } from './identity';

// ── The images row (mirrors backend/src/gallery.ts ImageRow) ─────────────────
type ImageRow = {
  id: string;
  source: 'elle' | 'vosjay' | 'chatjay';
  status: 'pending' | 'complete' | 'error';
  path: 'verbatim' | 'authored';
  error: string | null;
  prompt_raw: string;
  prompt_rendered: string | null;
  model: string;
  aspect_ratio: string | null;
  resolution: string | null;
  storage_path: string | null;
  thumbnail_path: string | null;
  width: number | null;
  height: number | null;
  cost: number | null;
  reference_images: { slug: string; role: string }[] | null;
  favourite: boolean;
  created_at: string;
  completed_at: string | null;
};

type Reference = { slug: string; kind: 'character' | 'location'; display_name: string };
type ModelSpec = {
  id: string;
  label: string;
  aspectRatios: string[];
  resolutions: string[];
  maxRefs: number;
};

const POLL_MS = 30_000; // idle grid poll; pending rows get their own 2.5s loop
const PENDING_POLL_MS = 2_500;
const STALE_MS = 60_000;
const PAGE_SIZE = 100;
const ARM_MS = 3_000; // delete two-tap, same rhythm as the Hearth's Everything off
const SEARCH_DEBOUNCE_MS = 350;
const COMPOSER_FOLDED_KEY = 'vale-gallery-composer-folded';

type SortKey = 'created_at' | 'cost' | 'resolution';
const SORT_LABEL: Record<SortKey, string> = {
  created_at: 'Date',
  cost: 'Cost',
  resolution: 'Size',
};

// Door labels resolve from Identity (Haven fork): the source slugs are stable
// identifiers in live rows (the Décor slot-key ruling), the names shown are
// this house's. 'chatjay' is the external-connector door.
const sourceLabels = (
  userName: string,
  companionName: string,
): Record<ImageRow['source'], string> => ({
  elle: userName,
  vosjay: companionName,
  chatjay: 'Connector',
});

// crypto.randomUUID with the getRandomValues fallback (Thu's iOS/HTTP lesson).
function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// "THURSDAY 17 JULY 2026" — grid group headers, dated in the install's own
// timezone (Identity config; Perth on ours).
const dayFmtFor = (tz: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
const dayKeyFmtFor = (tz: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

function fileUrl(path: string): string {
  return apiUrl(`/gallery/file/${path}`);
}

export function Gallery({ active }: { active: boolean }) {
  const identity = useIdentity();
  const SOURCE_LABEL = sourceLabels(identity.user_name, identity.companion_name);
  const dayFmt = useMemo(() => dayFmtFor(identity.timezone), [identity.timezone]);
  const dayKeyFmt = useMemo(() => dayKeyFmtFor(identity.timezone), [identity.timezone]);
  // ── Server-owned grid state ────────────────────────────────────────────────
  const [images, setImages] = useState<ImageRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  // ── The composer ───────────────────────────────────────────────────────────
  const [prompt, setPrompt] = useState('');
  const [polish, setPolish] = useState(false); // OFF by default — verbatim is the fence
  const [aspect, setAspect] = useState('1:1');
  const [resolution, setResolution] = useState('1K');
  const [selRefs, setSelRefs] = useState<string[]>([]);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  // ── The reference picker + model catalog (loaded on first activation) ─────
  const [references, setReferences] = useState<Reference[]>([]);
  const [models, setModels] = useState<ModelSpec[]>([]);
  // The picker: catalog order is the server's (NB2 first — the house default).
  const [modelId, setModelId] = useState<string | null>(null);
  const model = models.find((m) => m.id === modelId) ?? models[0] ?? null;

  // Switching models re-validates every dependent option (Thu's pattern):
  // anything the new model can't do falls back to its first allowed value,
  // and picked refs clamp to its cap.
  function pickModel(m: ModelSpec) {
    setModelId(m.id);
    setAspect((a) => (m.aspectRatios.includes(a) ? a : m.aspectRatios[0]));
    setResolution((r) => (m.resolutions.includes(r) ? r : m.resolutions[0]));
    setSelRefs((sel) => sel.slice(0, m.maxRefs));
  }

  // ── Detail view + delete arm ───────────────────────────────────────────────
  const [detailId, setDetailId] = useState<string | null>(null);
  const [armedDelete, setArmedDelete] = useState(false);
  const armTimer = useRef<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null); // which copy button just fired

  // ── Composer fold (remembered, Hearth-style) ───────────────────────────────
  const [composerFolded, setComposerFolded] = useState(
    () => localStorage.getItem(COMPOSER_FOLDED_KEY) === '1',
  );
  function toggleComposer() {
    setComposerFolded((f) => {
      try {
        localStorage.setItem(COMPOSER_FOLDED_KEY, f ? '' : '1');
      } catch {
        /* storage unavailable — fold still works for the session */
      }
      return !f;
    });
  }

  // ── The toolbar: search + sort + filters, all SERVER-side ─────────────────
  // (Thu's own known limitation was client-side filtering over loaded rows —
  // her handover says move it into the query; we start there.)
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('created_at');
  const [dirAsc, setDirAsc] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [fSource, setFSource] = useState<string | null>(null);
  const [fModel, setFModel] = useState<string | null>(null);
  const [fRatio, setFRatio] = useState<string | null>(null);
  const [fRef, setFRef] = useState<string | null>(null);
  const [fFav, setFFav] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setQ(qInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [qInput]);

  const toolbarActive =
    !!q || sort !== 'created_at' || dirAsc || !!fSource || !!fModel || !!fRatio || !!fRef || fFav;
  // One string capturing the whole toolbar state — refresh keys off it.
  const filterKey = [q, sort, dirAsc ? 'asc' : 'desc', fSource, fModel, fRatio, fRef, fFav]
    .map((v) => String(v ?? ''))
    .join('|');

  const listPath = useCallback(
    (offset: number) => {
      const p = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (offset) p.set('offset', String(offset));
      if (q) p.set('q', q);
      if (sort !== 'created_at') p.set('sort', sort);
      if (dirAsc) p.set('dir', 'asc');
      if (fSource) p.set('source', fSource);
      if (fModel) p.set('model', fModel);
      if (fRatio) p.set('aspect_ratio', fRatio);
      if (fRef) p.set('ref', fRef);
      if (fFav) p.set('favourite', 'true');
      return `/gallery/images?${p.toString()}`;
    },
    [q, sort, dirAsc, fSource, fModel, fRatio, fRef, fFav],
  );

  const merge = useCallback((prev: ImageRow[] | null, incoming: ImageRow[]): ImageRow[] => {
    const byId = new Map((prev ?? []).map((i) => [i.id, i]));
    for (const row of incoming) byId.set(row.id, row);
    return [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, []);

  // Update rows in place by id WITHOUT re-sorting — the server owns the order
  // whenever the toolbar is active (a cost-sorted page must stay cost-sorted).
  const updateById = useCallback((prev: ImageRow[] | null, incoming: ImageRow[]): ImageRow[] => {
    const byId = new Map(incoming.map((i) => [i.id, i]));
    return (prev ?? []).map((r) => byId.get(r.id) ?? r);
  }, []);

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const res = await api(listPath(0));
      const data = await res.json();
      if (data.ok) {
        // Toolbar views REPLACE (server order + server filter are the truth);
        // the default view merges so load-more pages survive the idle poll.
        setImages((prev) => (toolbarActive ? data.images : merge(prev, data.images)));
        setHasMore(data.images.length === PAGE_SIZE);
        setLoadFailed(false);
        return true;
      }
      setLoadFailed(true);
      return false;
    } catch (err) {
      console.error('Failed to load gallery:', err);
      setLoadFailed(true);
      return false;
    }
  }, [merge, listPath, toolbarActive]);

  const { lastSuccessAt, failing } = useVisiblePoll(refresh, POLL_MS, active);

  // A toolbar change is a new view: show the loading state once and refetch
  // now rather than waiting for the poll's next tick.
  const firstFilterRun = useRef(true);
  useEffect(() => {
    if (firstFilterRun.current) {
      firstFilterRun.current = false;
      return;
    }
    if (!active) return;
    setImages(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, active]);

  // References + catalog, once per session (they change by migration, not by minute).
  const refsLoaded = useRef(false);
  useEffect(() => {
    if (!active || refsLoaded.current) return;
    refsLoaded.current = true;
    void (async () => {
      try {
        const res = await api(`/gallery/references`);
        const data = await res.json();
        if (data.ok) {
          setReferences(data.references);
          setModels(data.models);
        }
      } catch (err) {
        console.error('Failed to load references:', err);
        refsLoaded.current = false; // retry on next activation
      }
    })();
  }, [active]);

  // The fast lane: while any row is pending, poll just those ids at 2.5s. The
  // 15-minute ceiling is the server's (a pending row older than that is dead
  // to the concurrency gate and will land as error or stay skeleton until
  // refresh); the loop itself stops the moment nothing is pending.
  const pendingKey = (images ?? [])
    .filter((i) => i.status === 'pending')
    .map((i) => i.id)
    .join(',');
  useEffect(() => {
    if (!active || !pendingKey) return;
    const t = window.setInterval(() => {
      void (async () => {
        try {
          const res = await api(`/gallery/images?ids=${pendingKey}`);
          const data = await res.json();
          // In-place when the toolbar owns the order; merge in the default view.
          if (data.ok) {
            setImages((prev) => (toolbarActive ? updateById(prev, data.images) : merge(prev, data.images)));
          }
        } catch {
          /* the idle poll will catch up */
        }
      })();
    }, PENDING_POLL_MS);
    return () => clearInterval(t);
  }, [active, pendingKey, merge, updateById, toolbarActive]);

  // ── Actions ────────────────────────────────────────────────────────────────

  async function generate() {
    const text = prompt.trim();
    if (!text || generating || !model) return;
    setComposeError(null);
    setGenerating(true);
    try {
      const res = await api(`/gallery/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: uuid(),
          prompt: text,
          path: polish ? 'authored' : 'verbatim',
          model: model.id,
          aspect_ratio: aspect,
          resolution,
          reference_slugs: selRefs,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setComposeError(data.error ?? 'generation failed to start');
        return;
      }
      // Prepend regardless of view — she just made it; she should see it.
      setImages((prev) => [data.image, ...(prev ?? []).filter((i) => i.id !== data.image.id)]);
    } catch (err) {
      setComposeError((err as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  async function retry(id: string) {
    try {
      const res = await api(`/gallery/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (data.ok) setImages((prev) => merge(prev, [data.image]));
    } catch (err) {
      console.error('Retry failed:', err);
    }
  }

  async function remove(id: string) {
    // Optimistic removal with rollback — the row is small, the regret is smaller.
    const prev = images;
    setImages((p) => (p ?? []).filter((i) => i.id !== id));
    setDetailId((d) => (d === id ? null : d));
    try {
      const res = await api(`/gallery/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!data.ok) setImages(prev);
    } catch {
      setImages(prev);
    }
  }

  async function toggleFavourite(row: ImageRow) {
    const next = !row.favourite;
    setImages((p) => (p ?? []).map((i) => (i.id === row.id ? { ...i, favourite: next } : i)));
    try {
      const res = await api(`/gallery/favourite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id, favourite: next }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
    } catch {
      setImages((p) => (p ?? []).map((i) => (i.id === row.id ? { ...i, favourite: row.favourite } : i)));
    }
  }

  async function loadMore() {
    try {
      const res = await api(listPath((images ?? []).length));
      const data = await res.json();
      if (data.ok) {
        // Append preserving server order in toolbar views; merge otherwise.
        setImages((prev) => {
          if (!toolbarActive) return merge(prev, data.images);
          const seen = new Set((prev ?? []).map((i) => i.id));
          return [...(prev ?? []), ...(data.images as ImageRow[]).filter((i) => !seen.has(i.id))];
        });
        setHasMore(data.images.length === PAGE_SIZE);
      }
    } catch (err) {
      console.error('Load more failed:', err);
    }
  }

  function clearComposer() {
    setPrompt('');
    setSelRefs([]);
    setPolish(false);
    setComposeError(null);
  }

  // Copy with a per-button "copied" flash; execCommand fallback for older iOS.
  function copyText(key: string, text: string) {
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    })();
  }

  function toggleRef(slug: string) {
    setSelRefs((sel) => {
      if (sel.includes(slug)) return sel.filter((s) => s !== slug);
      if (model && sel.length >= model.maxRefs) return sel; // cap, silently firm
      return [...sel, slug];
    });
  }

  // Thu's pair, both halves: "use prompt" reloads the words; this reloads the
  // knobs — model, ratio, size, refs, and the Polish state the row was made
  // with — each clamped to what the (possibly different) current catalog
  // still allows.
  function usePromptSettings(row: ImageRow) {
    const m = models.find((x) => x.id === row.model);
    if (m) {
      setModelId(m.id);
      setAspect(row.aspect_ratio && m.aspectRatios.includes(row.aspect_ratio) ? row.aspect_ratio : m.aspectRatios[0]);
      setResolution(row.resolution && m.resolutions.includes(row.resolution) ? row.resolution : m.resolutions[0]);
      const known = new Set(references.map((r) => r.slug));
      setSelRefs((row.reference_images ?? []).map((r) => r.slug).filter((s) => known.has(s)).slice(0, m.maxRefs));
    }
    setPolish(row.path === 'authored');
    setDetailId(null);
  }

  function armDelete(id: string) {
    if (!armedDelete) {
      setArmedDelete(true);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => setArmedDelete(false), ARM_MS);
      return;
    }
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmedDelete(false);
    void remove(id);
  }

  // Detail closes → the delete arm resets with it.
  useEffect(() => {
    if (detailId === null) setArmedDelete(false);
  }, [detailId]);

  // ── Derived grid: date groups, newest first ────────────────────────────────
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; rows: ImageRow[] }>();
    for (const row of images ?? []) {
      const d = new Date(row.created_at);
      const key = dayKeyFmt.format(d);
      if (!map.has(key)) map.set(key, { label: dayFmt.format(d).toUpperCase(), rows: [] });
      map.get(key)!.rows.push(row);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([, g]) => g);
  }, [images, dayFmt, dayKeyFmt]);

  const detail = detailId ? (images ?? []).find((i) => i.id === detailId) ?? null : null;
  const characters = references.filter((r) => r.kind === 'character');
  const locations = references.filter((r) => r.kind === 'location');

  // ── Tiles ──────────────────────────────────────────────────────────────────

  function tile(row: ImageRow) {
    if (row.status === 'pending') {
      return (
        <div key={row.id} className="gal-tile gal-tile--skeleton" title={row.prompt_raw}>
          <i className="ti ti-photo" aria-hidden="true" />
        </div>
      );
    }
    if (row.status === 'error') {
      return (
        <div key={row.id} className="gal-tile gal-tile--error" title={row.error ?? 'failed'}>
          <i className="ti ti-photo-x" aria-hidden="true" />
          <div className="gal-tile__err">{row.error ?? 'failed'}</div>
          <div className="gal-tile__acts">
            <button onClick={() => void retry(row.id)} aria-label="Retry">
              <i className="ti ti-refresh" aria-hidden="true" />
            </button>
            <button onClick={() => void remove(row.id)} aria-label="Dismiss">
              <i className="ti ti-x" aria-hidden="true" />
            </button>
          </div>
        </div>
      );
    }
    const src = row.thumbnail_path ?? row.storage_path;
    return (
      <button key={row.id} className="gal-tile" onClick={() => setDetailId(row.id)}>
        {src && <img src={fileUrl(src)} alt={row.prompt_raw.slice(0, 80)} loading="lazy" />}
        {row.favourite && <i className="ti ti-heart gal-tile__fav" aria-hidden="true" />}
      </button>
    );
  }

  // ── Detail view ────────────────────────────────────────────────────────────

  function detailView(row: ImageRow) {
    const refs = (row.reference_images ?? []).map((r) => r.slug);
    const made = new Date(row.created_at);
    return (
      <div className="gal-detail">
        <button className="gal-detail__back" onClick={() => setDetailId(null)}>
          <i className="ti ti-arrow-left" aria-hidden="true" /> Gallery
        </button>

        <div className="gal-detail__imgwrap">
          {row.storage_path && (
            <img src={fileUrl(row.storage_path)} alt={row.prompt_raw.slice(0, 80)} />
          )}
        </div>

        <div className="gal-detail__actions">
          <button onClick={() => void toggleFavourite(row)}>
            <i
              className={`ti ti-heart ${row.favourite ? 'gal-fav--on' : ''}`}
              aria-hidden="true"
            />
            {row.favourite ? 'Loved' : 'Love it'}
          </button>
          {row.storage_path && (
            <a href={fileUrl(row.storage_path)} download={`${row.id}.png`}>
              <i className="ti ti-download" aria-hidden="true" /> Download
            </a>
          )}
          <button
            onClick={() => {
              setPrompt(row.prompt_raw);
              setDetailId(null);
            }}
          >
            <i className="ti ti-pencil" aria-hidden="true" /> Use prompt
          </button>
          <button onClick={() => usePromptSettings(row)}>
            <i className="ti ti-adjustments" aria-hidden="true" /> Use settings
          </button>
        </div>

        <div className="gal-card">
          <div className="gal-card__head">
            <div className="gal-card__label">Prompt{row.path === 'authored' ? ' (before Polish)' : ''}</div>
            <button
              className="gal-copy"
              aria-label="Copy prompt"
              onClick={() => copyText('raw', row.prompt_raw)}
            >
              <i className={`ti ${copied === 'raw' ? 'ti-check' : 'ti-copy'}`} aria-hidden="true" />
              {copied === 'raw' ? 'copied' : 'copy'}
            </button>
          </div>
          <div className="gal-card__body">{row.prompt_raw}</div>
          {row.prompt_rendered && (
            <>
              <div className="gal-card__head">
                <div className="gal-card__label">Polished — what getimg received</div>
                <button
                  className="gal-copy"
                  aria-label="Copy polished prompt"
                  onClick={() => copyText('rendered', row.prompt_rendered!)}
                >
                  <i className={`ti ${copied === 'rendered' ? 'ti-check' : 'ti-copy'}`} aria-hidden="true" />
                  {copied === 'rendered' ? 'copied' : 'copy'}
                </button>
              </div>
              <div className="gal-card__body gal-card__body--muted">{row.prompt_rendered}</div>
            </>
          )}
        </div>

        <div className="gal-card">
          <div className="gal-card__label">Details</div>
          <div className="gal-meta">
            <span>by {SOURCE_LABEL[row.source]}</span>
            <span>{models.find((m) => m.id === row.model)?.label ?? row.model}</span>
            {row.aspect_ratio && <span>{row.aspect_ratio}</span>}
            {row.resolution && <span>{row.resolution}</span>}
            {row.width && row.height && <span>{row.width}×{row.height}</span>}
            {row.cost !== null && <span>${Number(row.cost).toFixed(3)}</span>}
            <span>{dayFmt.format(made)}</span>
            {refs.length > 0 && <span>refs: {refs.join(', ')}</span>}
          </div>
        </div>

        <button
          className={`gal-delete ${armedDelete ? 'gal-delete--armed' : ''}`}
          onClick={() => armDelete(row.id)}
        >
          <i className="ti ti-trash" aria-hidden="true" />
          {armedDelete ? 'Sure? Gone for good' : 'Delete'}
        </button>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (detail) return <div className="gallery">{detailView(detail)}</div>;

  return (
    <div className="gallery">
      {lastSuccessAt !== null && (failing || Date.now() - lastSuccessAt > STALE_MS) && (
        <div className="room-stale">
          <i className="ti ti-cloud-off" aria-hidden="true" /> updated {agoLabel(lastSuccessAt)}
        </div>
      )}

      {/* ── Composer — collapsible, so the grid gets the room when she's browsing ── */}
      <div className="gal-composer">
        <button
          className="gal-fold"
          aria-expanded={!composerFolded}
          onClick={toggleComposer}
        >
          <span className="gal-fold__name">
            <i className="ti ti-brush" aria-hidden="true" /> Composer
          </span>
          <span className="gal-fold__meta">
            {composerFolded && model
              ? `${model.label} · ${aspect} · ${resolution} · Polish ${polish ? 'on' : 'off'}`
              : ''}
            <i
              className={`ti ${composerFolded ? 'ti-chevron-right' : 'ti-chevron-down'}`}
              aria-hidden="true"
            />
          </span>
        </button>
        {!composerFolded && (
        <>
        <textarea
          className="gal-composer__text"
          placeholder="What shall we make?"
          value={prompt}
          rows={3}
          maxLength={4096}
          onChange={(e) => setPrompt(e.target.value)}
        />

        {models.length > 1 && (
          <div className="gal-opt">
            <span className="gal-opt__label">Model</span>
            <div className="gal-chips">
              {models.map((m) => (
                <button
                  key={m.id}
                  className={`gal-chip ${model?.id === m.id ? 'gal-chip--on' : ''}`}
                  onClick={() => pickModel(m)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {model && (
          <>
            <div className="gal-opt">
              <span className="gal-opt__label">Ratio</span>
              <div className="gal-chips">
                {model.aspectRatios.map((a) => (
                  <button
                    key={a}
                    className={`gal-chip ${aspect === a ? 'gal-chip--on' : ''}`}
                    onClick={() => setAspect(a)}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>
            <div className="gal-opt">
              <span className="gal-opt__label">Size</span>
              <div className="gal-chips">
                {model.resolutions.map((r) => (
                  <button
                    key={r}
                    className={`gal-chip ${resolution === r ? 'gal-chip--on' : ''}`}
                    onClick={() => setResolution(r)}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {references.length > 0 && model && model.maxRefs > 0 && (
          <div className="gal-opt">
            <span className="gal-opt__label">Refs</span>
            <div className="gal-chips">
              {[...characters, ...locations].map((r) => (
                <button
                  key={r.slug}
                  className={`gal-chip ${selRefs.includes(r.slug) ? 'gal-chip--on' : ''}`}
                  onClick={() => toggleRef(r.slug)}
                >
                  <i
                    className={`ti ${r.kind === 'character' ? 'ti-user' : 'ti-home'}`}
                    aria-hidden="true"
                  />{' '}
                  {r.display_name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="gal-composer__row">
          <button
            className="gal-clear"
            aria-label="Clear the composer"
            disabled={!prompt && selRefs.length === 0 && !polish}
            onClick={clearComposer}
          >
            <i className="ti ti-eraser" aria-hidden="true" />
            Clear
          </button>
          {/* Polish — the fence, visible. Off = your words verbatim. */}
          <button
            className={`gal-polish ${polish ? 'gal-polish--on' : ''}`}
            aria-pressed={polish}
            onClick={() => setPolish((p) => !p)}
          >
            <i className="ti ti-wand" aria-hidden="true" />
            Polish {polish ? 'on' : 'off'}
          </button>
          <button
            className="gal-generate"
            disabled={generating || !prompt.trim()}
            onClick={() => void generate()}
          >
            {generating ? 'Starting…' : 'Generate'}
          </button>
        </div>
        {polish && (
          <div className="gal-composer__hint">
            Polish rewrites your prompt through the render pass — refs picked above ride along.
          </div>
        )}
        {composeError && <div className="gal-composer__err">{composeError}</div>}
        </>
        )}
      </div>

      {/* ── Toolbar: search, sort, filters — the query does the work ── */}
      <div className="gal-toolbar">
        <div className="gal-search">
          <i className="ti ti-search" aria-hidden="true" />
          <input
            value={qInput}
            placeholder="Search prompts"
            onChange={(e) => setQInput(e.target.value)}
          />
          {qInput && (
            <button aria-label="Clear search" onClick={() => setQInput('')}>
              <i className="ti ti-x" aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="gal-sortrow">
          {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
            <button
              key={k}
              className={`gal-chip ${sort === k ? 'gal-chip--on' : ''}`}
              onClick={() => {
                if (sort === k) setDirAsc((d) => !d);
                else {
                  setSort(k);
                  setDirAsc(false);
                }
              }}
            >
              {SORT_LABEL[k]}
              {sort === k && (
                <i className={`ti ${dirAsc ? 'ti-arrow-up' : 'ti-arrow-down'}`} aria-hidden="true" />
              )}
            </button>
          ))}
          <button
            className={`gal-chip gal-chip--filters ${filtersOpen || fSource || fModel || fRatio || fRef || fFav ? 'gal-chip--on' : ''}`}
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((o) => !o)}
          >
            <i className="ti ti-filter" aria-hidden="true" /> Filters
          </button>
        </div>
        {filtersOpen && (
          <div className="gal-filters">
            <div className="gal-opt">
              <span className="gal-opt__label">By</span>
              <div className="gal-chips">
                {(['elle', 'vosjay', 'chatjay'] as const).map((s) => (
                  <button
                    key={s}
                    className={`gal-chip ${fSource === s ? 'gal-chip--on' : ''}`}
                    onClick={() => setFSource((v) => (v === s ? null : s))}
                  >
                    {SOURCE_LABEL[s]}
                  </button>
                ))}
                <button
                  className={`gal-chip ${fFav ? 'gal-chip--on' : ''}`}
                  onClick={() => setFFav((v) => !v)}
                >
                  <i className="ti ti-heart" aria-hidden="true" /> Loved
                </button>
              </div>
            </div>
            {models.length > 1 && (
              <div className="gal-opt">
                <span className="gal-opt__label">Model</span>
                <div className="gal-chips">
                  {models.map((m) => (
                    <button
                      key={m.id}
                      className={`gal-chip ${fModel === m.id ? 'gal-chip--on' : ''}`}
                      onClick={() => setFModel((v) => (v === m.id ? null : m.id))}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="gal-opt">
              <span className="gal-opt__label">Ratio</span>
              <div className="gal-chips">
                {[...new Set(models.flatMap((m) => m.aspectRatios))].map((a) => (
                  <button
                    key={a}
                    className={`gal-chip ${fRatio === a ? 'gal-chip--on' : ''}`}
                    onClick={() => setFRatio((v) => (v === a ? null : a))}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>
            {references.length > 0 && (
              <div className="gal-opt">
                <span className="gal-opt__label">Refs</span>
                <div className="gal-chips">
                  {references.map((r) => (
                    <button
                      key={r.slug}
                      className={`gal-chip ${fRef === r.slug ? 'gal-chip--on' : ''}`}
                      onClick={() => setFRef((v) => (v === r.slug ? null : r.slug))}
                    >
                      {r.display_name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Grid — date-grouped on the default sort, flat when the server
             ordering is by anything else (cost/size groups by date lie) ── */}
      {images === null ? (
        <div className="gal-state">{loadFailed ? "Couldn't reach the Gallery" : 'Opening the Gallery…'}</div>
      ) : images.length === 0 ? (
        <div className="gal-state">
          <i className="ti ti-photo" aria-hidden="true" />
          {toolbarActive ? 'Nothing matches — loosen the search or filters.' : 'No images yet. Make the first one.'}
        </div>
      ) : (
        <>
          {sort === 'created_at' ? (
            groups.map((g) => (
              <div key={g.label} className="gal-group">
                <div className="gal-group__head">{g.label}</div>
                <div className="gal-grid">{g.rows.map(tile)}</div>
              </div>
            ))
          ) : (
            <div className="gal-grid">{images.map(tile)}</div>
          )}
          {hasMore && (
            <button className="gal-more" onClick={() => void loadMore()}>
              Load more
            </button>
          )}
        </>
      )}
    </div>
  );
}
