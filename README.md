# Haven OS

A self-hosted home for one person and their AI companion.

One Cloudflare Worker serves a private PWA — a house with rooms: a **Front
Room** where you and your companion talk (streaming, with long-term memory), a
**Workshop** of read-only Notion views you compose yourself, a **Hearth** that
drives your Home Assistant lights, scenes, vacuum and speakers, and a
**Gallery** where the companion can make real images of your world. Behind a
second lock sits the **Fuse Box** — the admin panel where every key, name,
memory, theme and mapping lives as editable config. Nothing personal is in this
code: who lives in the house, how it looks, and what it remembers are all data
in your own database.

You run it on your own accounts. Your keys, your bill, your canon.

## What you need

- A **GitHub** account (the deploy button clones this template into it).
- A **Cloudflare** account (free tier works) — runs the Worker, stores files,
  holds your keys.
- A **Supabase** project (free tier works) — the database.
- An **Anthropic API key** — the one key the house can't open without.
- Optional, each unlocking a room or ability, addable any time later from the
  admin panel: **Notion** (Workshop), **Home Assistant** URL + token (Hearth),
  **ElevenLabs** (voice notes), **getimg** (Gallery), **OpenRouter**
  (long-term-memory embeddings).

## Setting up

1. **Create the Supabase project**, then open its SQL Editor, paste the whole
   of [`supabase/setup.sql`](supabase/setup.sql), and Run once. That's the
   entire database step.
2. **Click Deploy to Cloudflare** (button below). It clones this repo into
   your GitHub, provisions the two storage buckets and the secrets store, asks
   you for the three deploy-time values (see [`.env.example`](.env.example) —
   all copy-paste), builds, and deploys. Future pushes to your repo deploy
   automatically.
3. **Open your Worker's URL.** A fresh install boots to a short setup wizard:
   pick the app password, paste the Anthropic key, name the house and the two
   of you, paste your companion's prompt. Then the front door works and your
   companion can talk.
4. Everything else — more keys, smart-home rosters, Workshop blocks, reference
   images, a memory seed, the décor — is a panel in **the Fuse Box** (drawer →
   The Fuse Box, desktop only), flipped whenever you're ready. No deploys.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rainbowllamaspatula/haven-os)

## Honest requirements & limits

- **Single-user by design.** One password, one person, one companion. There is
  no multi-tenant anything.
- **The Anthropic key is load-bearing**; every other key degrades gracefully —
  a room without its key says exactly what it needs and where to set it.
- **Memory writes without the OpenRouter key are refused, not degraded** — the
  house never stores a memory it can't embed (retrieval integrity beats
  convenience).
- **Dormant rooms** (Post Box, Listening Room, and other future rooms) ship in
  the code but sit inert in the drawer. Updates arrive as pull requests you
  merge; merging deploys.
- **Internal identifiers:** a few database enums use the slugs `elle`/`jay`
  (user/companion roles) and `vosjay`/`chatjay` (image-door sources). They are
  stable internal identifiers from the source house — every visible surface
  resolves the names *you* configure. Code comments likewise carry the source
  house's build history.
- **The mood system's calibration prose currently uses she/her** for the user —
  a known v1 limitation.
- The admin panel (Fuse Box) is **desktop-only**, deliberately.

## Layout

- `backend/` — the Cloudflare Worker: API, auth gate, the companion's brain,
  every room's server half. `backend/AGENTS.md` lists the guardrails.
- `frontend/` — the Vite + React PWA the Worker serves.
- `supabase/setup.sql` — the one-paste database setup.

## Security posture

- One password gates the app; a second prompt of the same password gates the
  admin panel (15-minute sessions).
- Outbound API keys live in Cloudflare Secrets Store: write-only from the
  panel, readable only by the Worker at runtime, rotatable without a deploy.
- The database is service-role only — no anonymous Supabase access exists.
- R2 buckets are never public; media serves through session-gated routes.
