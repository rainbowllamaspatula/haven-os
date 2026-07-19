import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // injectManifest (not generateSW): the service worker is ours
      // (src/sw.ts), built on Workbox modules. We need navigations to be
      // network-only so the Worker's auth gate always decides what a fresh
      // session sees — generateSW's navigateFallback would serve the cached
      // shell cache-first and skip straight past the login page.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // Registration is done by hand in main.tsx (production-only).
      injectRegister: false,
      // Launcher PNGs are not part of the shell cache — the OS fetches them
      // at install time. Without this the plugin precaches all manifest icons.
      includeManifestIcons: false,
      injectManifest: {
        // Precache the app shell: built HTML/JS/CSS, woff2 fonts (Fraunces,
        // Inter, JetBrains Mono, Tabler icons) and the small SVGs. The
        // launcher PNGs are deliberately not precached — the OS fetches
        // those at install time; they'd bloat the shell cache for nothing.
        globPatterns: ['**/*.{js,css,html,woff2,svg}'],
      },
      manifest: {
        // Neutral names (Haven fork): the Worker rewrites name/short_name from
        // the Identity circuit at serve time, so each house's launcher says its
        // own name with no deploy. The description stays neutral by design.
        name: 'Haven OS',
        short_name: 'Haven OS',
        description: 'A private home.',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // NEUTRAL default values (the Décor circuit): the manifest is baked
        // at build time, so these are deploy-bound — a themed install's
        // splash/status wear these until the next deploy. Listed honestly in
        // the Décor circuit's panel notes.
        theme_color: '#141618',
        background_color: '#1D2022',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
})
