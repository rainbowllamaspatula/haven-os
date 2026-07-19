/**
 * The Décor runtime — the client half of the theme engine.
 *
 * The shell paints correctly before React exists (index.html's boot script +
 * the Worker's serve-time injection); this module keeps it correct after:
 * fetch the active theme, apply it to the #decor style tag, keep the
 * last-good copy in localStorage for offline cold starts, and keep the PWA
 * status bar (meta theme-color) matching the worn background.
 *
 * The caching boundary holds: this is a plain /api fetch (NetworkOnly in the
 * service worker); the only client-side cache is the deliberate last-good
 * copy, same spirit as every room's frozen last-good.
 */

import { api } from './api';

const STORAGE_KEY = 'vale-decor-css';

// The compiled-in neutral background — must match index.html's meta and the
// neutral `--bg` in index.css. Used when no theme is active.
const NEUTRAL_BG = '#141618';

function decorEl(): HTMLStyleElement {
  let el = document.getElementById('decor') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = 'decor';
    document.body.prepend(el);
  }
  return el;
}

/** Point the PWA status bar at the background the app actually wears. */
function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  meta.setAttribute('content', bg || NEUTRAL_BG);
}

/** Apply theme CSS (null = no active theme → neutral) and persist last-good. */
export function applyDecor(css: string | null) {
  decorEl().textContent = css ?? '';
  try {
    if (css === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, css);
  } catch {
    /* storage unavailable — the live application still happened */
  }
  syncThemeColor();
}

/**
 * Fetch the active theme and wear it. Quiet on failure — the shell already
 * wears last-good (or neutral), and lying walls are worse than stale ones.
 */
export async function refreshDecor(): Promise<void> {
  try {
    const res = await api('/decor/active');
    const data = (await res.json()) as { ok: boolean; css: string | null };
    if (data.ok) applyDecor(data.css);
  } catch {
    /* offline or the Worker is unhappy — last-good stands */
  }
}

// The Fuse Box announces panel-side changes (save/activate/deactivate) with
// this event so the app re-dresses immediately, same document, no reload.
export const DECOR_CHANGED_EVENT = 'vale-decor-changed';

// ── The light switch ─────────────────────────────────────────────────────────
// The worn MODE is device dressing, not house config: it lives in this
// device's localStorage, never in a row. Absence of the attribute means dark
// (the house default). index.html's boot script applies the stored mode
// before first paint; this pair is the runtime's half.

const MODE_KEY = 'vale-decor-mode';

export type DecorMode = 'dark' | 'light';

export function getDecorMode(): DecorMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function setDecorMode(mode: DecorMode) {
  if (mode === 'light') document.documentElement.setAttribute('data-decor-mode', 'light');
  else document.documentElement.removeAttribute('data-decor-mode');
  try {
    if (mode === 'light') localStorage.setItem(MODE_KEY, 'light');
    else localStorage.removeItem(MODE_KEY);
  } catch {
    /* storage unavailable — the mode still applied for this session */
  }
  syncThemeColor();
}

/**
 * Preview: paint THIS browser session with a draft theme without activating
 * it for the house. A second style tag after #decor wins the cascade; exit
 * removes it and the real theme shows through untouched.
 */
export function setDecorPreview(css: string | null) {
  let el = document.getElementById('decor-preview') as HTMLStyleElement | null;
  if (css === null) {
    el?.remove();
    syncThemeColor();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = 'decor-preview';
    const anchor = decorEl();
    anchor.parentNode?.insertBefore(el, anchor.nextSibling);
  }
  el.textContent = css;
  syncThemeColor();
}
