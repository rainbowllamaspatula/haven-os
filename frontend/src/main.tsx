import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Fonts + icon webfont, bundled locally so the offline shell renders with no
// network. Latin subsets only — covers English and German. This is the Décor
// circuit's CURATED font list: every family a theme may pick must be bundled
// here (a Google Fonts link would punch a hole in the CDN-free shell).
// Atkinson Hyperlegible is Haven's body face; it ships 400/700 only — the
// browser synthesises the app's 500/600 weights, which is acceptable for a
// hyperlegibility-first face.
import '@fontsource/fraunces/latin-400.css'
import '@fontsource/fraunces/latin-500.css'
import '@fontsource/fraunces/latin-600.css'
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import '@fontsource/atkinson-hyperlegible/latin-400.css'
import '@fontsource/atkinson-hyperlegible/latin-700.css'
import '@tabler/icons-webfont/dist/tabler-icons.min.css'

import './index.css'
import App from './App.tsx'

// Register the service worker in production builds only, and never on
// localhost — mirrors the backend's production-only auth model, so the local
// sandbox (vite dev or wrangler dev) stays service-worker-free.
if (
  import.meta.env.PROD &&
  !['localhost', '127.0.0.1'].includes(location.hostname)
) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({ immediate: true })
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
