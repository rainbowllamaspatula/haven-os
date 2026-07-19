// Vale OS — the one fetch wrapper every room calls.
//
// It prepends the API base and, in production, turns a 401 (expired or rotated
// session) into a reload. The Worker gate serves the login page for the reloaded
// document request, so logging in lands straight back in the app — instead of the
// zombie-PWA state where tiles show last-good forever after a session lapses.
//
// Dev runs the sandbox open (no auth), so the reload is production-only — and
// harmless even if it never fires there.

const API_URL = import.meta.env.VITE_API_URL;

export async function api(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${API_URL}${path}`, init);
  if (res.status === 401 && import.meta.env.PROD) {
    // Session gone. Reload → the gate serves the login page.
    location.reload();
  }
  return res;
}

// The full URL for an API path — for elements that load a resource directly
// (the voice-note <audio> src) rather than fetching through api(). Same-origin
// in production, so the session cookie rides along exactly as it does for
// fetch; the 401-reload treatment doesn't apply (a media element can't reload
// the app, it just fails quietly and the next real api() call handles it).
export function apiUrl(path: string): string {
  return `${API_URL}${path}`;
}
