/**
 * Per-install identity, client half (Haven fork, 19 Jul 2026).
 *
 * Who lives in this house: the names every label, placeholder and aria used to
 * hardcode. Fetched once at boot from GET /api/identity, cached in
 * localStorage (the Décor last-good pattern) so a reload paints with the right
 * names before the fetch lands, and provided to every room via context.
 */

import { createContext, useContext } from 'react';
import { api } from './api';

export type Identity = {
  house_name: string;
  companion_name: string;
  user_name: string;
  companion_role: string;
  timezone: string;
};

/** What an undecorated house answers to — matches the backend's neutral. */
export const NEUTRAL_IDENTITY: Identity = {
  house_name: 'Haven OS',
  companion_name: 'your companion',
  user_name: 'you',
  companion_role: 'companion',
  timezone: 'UTC',
};

const STORAGE_KEY = 'vale-identity';

/** The last-good copy, for first paint. Neutral when none stored. */
export function storedIdentity(): Identity {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Identity>;
      if (parsed.house_name && parsed.companion_name && parsed.user_name) {
        return { ...NEUTRAL_IDENTITY, ...parsed };
      }
    }
  } catch {
    /* storage unavailable — neutral is fine */
  }
  return NEUTRAL_IDENTITY;
}

/** Fetch the live profile; null on failure (caller keeps what it has). */
export async function fetchIdentity(): Promise<Identity | null> {
  try {
    const res = await api('/identity');
    if (!res.ok) return null;
    const data = (await res.json()) as { ok: boolean; identity?: Identity };
    if (!data.ok || !data.identity) return null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data.identity));
    } catch {
      /* storage unavailable */
    }
    return data.identity;
  } catch {
    return null;
  }
}

/** Fired (on window) after the Fuse Box saves the profile, so the app
 * re-fetches and every label follows without a reload — the Décor pattern. */
export const IDENTITY_CHANGED_EVENT = 'vale-identity-changed';

export const IdentityContext = createContext<Identity>(NEUTRAL_IDENTITY);

/** The house's names, anywhere in the tree. */
export function useIdentity(): Identity {
  return useContext(IdentityContext);
}
