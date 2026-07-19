# Vale OS — Agent Guardrails

Vale OS is a private, single-user AI companion app. One git repo, two halves:

- `frontend/` — Vite + React + TypeScript. The PWA.
- `backend/` — one Cloudflare Worker. Serves the built frontend as static assets **and** the API under `/api/*`. Single origin. (For Cloudflare Workers specifics, see `backend/AGENTS.md`.)

Read the task brief before starting. If a change would touch anything under "Do not touch" below and the brief didn't explicitly ask for it — stop and ask.

## Do not touch without being explicitly asked

- **The brain** — prompt assembly (`backend/src/prompt.ts`), the static core (`backend/src/static-core.ts`), memory, and the Anthropic API wiring.
- **Auth** — the password gate and session handling (`backend/src/auth.ts`). Respect it; do not modify it.

## Hard rules

- **Caching boundary (non-negotiable).** Any service worker / caching may precache the static app shell, but must **never** cache `/api/*` or any auth / `Set-Cookie` response — those stay network-only. A cached API or auth response is a bug, not a feature.
- **Single origin.** One Worker serves the built frontend *and* `/api/*`. Do not break that model or the static-asset serving.
- **Production-only enforcement.** Auth (and any service-worker registration) is production-only. The local sandbox must keep working, untouched.
- **`frontend/public/icons.svg` is the in-app UI icon sprite — do not overwrite it.** App/launcher icons are separate files (`icon-*.png`, `apple-touch-icon-*.png`, `favicon.*`).
- **Never commit secrets.** They live as Worker secrets / `.dev.vars` (gitignored).

## Working style

- Small, clearly-messaged commits. Private repo — keep the history clean.
- Do not guess at Cloudflare APIs or limits — retrieve current docs (see `backend/AGENTS.md`).
