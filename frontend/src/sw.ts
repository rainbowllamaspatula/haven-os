/// <reference lib="webworker" />
/**
 * Vale OS — service worker (built by vite-plugin-pwa, injectManifest).
 *
 * The caching boundary, in one place (see AGENTS.md — non-negotiable):
 *
 *   - Static shell (hashed JS/CSS, fonts, SVGs, index.html) → precached,
 *     served cache-first by workbox-precaching.
 *   - `/api/*` → network-only, never cached. Live chat and history must
 *     always hit the Worker; a cached API response is a bug.
 *   - Navigations → network-only too, so the Worker's auth gate decides
 *     what a fresh session sees (login page vs app). The precached shell
 *     is used ONLY as the offline fallback. The login page and any
 *     Set-Cookie response therefore never enter a cache: NetworkOnly
 *     strategies store nothing.
 *
 * Versioning: Workbox revisions every precache entry per build and
 * cleanupOutdatedCaches() drops old caches on activate. skipWaiting +
 * clientsClaim mean a fresh deploy takes over on the next load — and since
 * navigations always come from the network, the next reload IS the new build.
 */
import { clientsClaim } from 'workbox-core'
import { precacheAndRoute, cleanupOutdatedCaches, matchPrecache } from 'workbox-precaching'
import { registerRoute, NavigationRoute, setCatchHandler } from 'workbox-routing'
import { NetworkOnly } from 'workbox-strategies'

declare let self: ServiceWorkerGlobalScope

self.skipWaiting()
clientsClaim()

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// The API is live or it is nothing. Never cached.
registerRoute(({ url }) => url.pathname.startsWith('/api/'), new NetworkOnly())

// Navigations go to the network so the auth gate keeps working exactly as it
// does now. Offline, the catch handler below serves the precached shell.
registerRoute(new NavigationRoute(new NetworkOnly()))

// Offline fallback: only for navigations, only the precached shell. The app
// itself renders the offline state — no fabricated replies.
setCatchHandler(async ({ request }) => {
  if (request.mode === 'navigate') {
    const shell = await matchPrecache('/index.html')
    if (shell) return shell
  }
  return Response.error()
})

// ── Web Push (Post Box) ─────────────────────────────────────────────────────
// The labelling Worker sends a payloadless push when new mail arrives. We fetch
// the glance from the app to build the notification — so there's no encrypted
// payload to carry — then show it (userVisibleOnly requires we always do). The
// /api/* fetch is network-only per the route above, so the caching boundary
// holds: nothing about mail is ever cached.
async function showMailNotification(): Promise<void> {
  let title = 'New mail'
  let body = 'Something just landed in the Post Box'
  try {
    const res = await fetch('/api/postbox/notification', { credentials: 'same-origin' })
    if (res.ok) {
      const data = (await res.json()) as {
        glance?: { unread: number; from: string | null; subject: string | null }
      }
      const g = data.glance
      if (g?.from && g?.subject) {
        title = g.from
        body = g.subject
      } else if (g && typeof g.unread === 'number') {
        body = `${g.unread} unread`
      }
    }
  } catch {
    /* fall back to the generic copy — a notification still fires */
  }
  await self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'vale-mail',
    data: { url: '/?room=post_box' },
  })
}

self.addEventListener('push', (event) => {
  event.waitUntil(showMailNotification())
})

// Tapping the notification focuses an open app window, or opens one at the Post
// Box. The app reads ?room=post_box on load to land in the right room.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url =
    (event.notification.data && (event.notification.data as { url?: string }).url) || '/'
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      for (const client of clientsList) {
        if ('focus' in client) {
          await client.focus()
          return
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url)
    })(),
  )
})
