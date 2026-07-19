/**
 * Bindings that `wrangler types` can't see on its own.
 *
 * VALE_PASSWORD is a production secret (set with `wrangler secret put`), so it
 * never appears in wrangler.jsonc and wouldn't otherwise make it into the Env
 * type. This declaration merges into the generated Env interface. Keep this file
 * free of imports/exports so it stays a global declaration.
 */

interface Env {
	/** The app password. Set with: npx wrangler secret put VALE_PASSWORD */
	VALE_PASSWORD: string;
	/**
	 * Session-signing secret — a long random string, independent of the password.
	 * HMAC key for session cookies (see auth.ts); rotating it forces a global
	 * re-login. Set with: npx wrangler secret put SESSION_SECRET
	 */
	SESSION_SECRET: string;
	/**
	 * NOTE (Fuse Box v0.3 cutover): the six MANAGED keys — ANTHROPIC_API_KEY,
	 * ELEVENLABS_API_KEY, GETIMG_API_KEY, HA_MCP_URL, HA_TOKEN, NOTION_TOKEN —
	 * are no longer declared here. They are Secrets Store bindings, declared in
	 * wrangler.jsonc (secrets_store_secrets), typed by `wrangler types`, and
	 * read ONLY through src/secrets.ts. This file keeps what config can't see:
	 * the Wrangler-resident classics (locks and plumbing).
	 */
	/**
	 * Notion API version header (>= 2025-09-03 for the data-sources endpoint).
	 * Non-secret — lives in wrangler.jsonc vars; declared here so the type knows
	 * it before the next `wrangler types` regen.
	 */
	NOTION_VERSION: string;
	/**
	 * Gmail OAuth (read-only) for the Workshop Mail tool. The Worker exchanges
	 * the long-lived refresh token for short-lived access tokens. All secrets —
	 * set them with `wrangler secret put`:
	 *   GMAIL_CLIENT_ID · GMAIL_CLIENT_SECRET · GMAIL_REFRESH_TOKEN
	 * The refresh token must come from an OAuth app published to Production (a
	 * Testing-mode token expires after 7 days for Gmail scopes).
	 */
	GMAIL_CLIENT_ID: string;
	GMAIL_CLIENT_SECRET: string;
	GMAIL_REFRESH_TOKEN: string;
	/**
	 * Spotify OAuth for the brain's playback control + the now-playing tile.
	 * Reuses the app (and scopes) behind Elle's existing Spotify MCP — the
	 * refresh token comes from ~/.spotify-mcp/tokens.json, the client id/secret
	 * from that project's .env. All secrets — set with `wrangler secret put`:
	 *   SPOTIFY_CLIENT_ID · SPOTIFY_CLIENT_SECRET · SPOTIFY_REFRESH_TOKEN
	 */
	SPOTIFY_CLIENT_ID: string;
	SPOTIFY_CLIENT_SECRET: string;
	SPOTIFY_REFRESH_TOKEN: string;
	/**
	 * Voice-note audio bucket (see wrangler.jsonc r2_buckets). Declared here so
	 * the type exists before the next `wrangler types` regen; the generated
	 * declaration is identical, so the merge stays clean.
	 */
	VOICE_NOTES: R2Bucket;
	/**
	 * Bearer token for ChatJay's /mcp surface (Door 3). Any long random string;
	 * the same value goes into his connector config. A secret:
	 *   npx wrangler secret put GALLERY_MCP_TOKEN
	 */
	GALLERY_MCP_TOKEN: string;
	/**
	 * R2 S3-compat credentials, Object-Read scoped to vale-os-gallery only —
	 * they exist solely so gallery.ts can presign 5-minute reference URLs for
	 * getimg to fetch (the R2 *binding* can't mint presigned URLs). Both
	 * secrets:  npx wrangler secret put R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
	 */
	R2_ACCESS_KEY_ID: string;
	R2_SECRET_ACCESS_KEY: string;
	/**
	 * Cloudflare account id — names the R2 S3 endpoint the presigner signs for.
	 * An identifier, not a secret; lives in wrangler.jsonc vars.
	 */
	CF_ACCOUNT_ID: string;
	/**
	 * Supabase service-role key (new-format sb_secret_). A secret (same tidy):
	 *   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
	 */
	SUPABASE_SERVICE_ROLE_KEY: string;
	/**
	 * Cloudflare Secrets Store — the keys circuit (fusebox-keys.ts). The store
	 * id is an identifier (wrangler.jsonc vars); the token is Edit-scoped to
	 * Secrets Store ONLY (can overwrite managed keys, can read no value, can
	 * touch no code) and stays a Wrangler secret forever per the
	 * inbound-credential rule:  npx wrangler secret put CF_SECRETS_STORE_TOKEN
	 */
	CF_STORE_ID: string;
	CF_SECRETS_STORE_TOKEN: string;
	/**
	 * Gallery image bucket (see wrangler.jsonc r2_buckets). Never public:
	 * images serve through the session-gated /api/gallery/file route, refs
	 * through short-lived presigned URLs.
	 */
	GALLERY: R2Bucket;
	/**
	 * The seventh managed key (Haven fork): OpenRouter, for the Worker-side
	 * embed call. Declared optional because its secrets_store_secrets binding
	 * ships commented until the store secret exists (see wrangler.jsonc) —
	 * absence is a real, handled state (embedText's loud Edge-Function
	 * fallback), so the type must admit it.
	 */
	OPENROUTER_API_KEY?: { get(): Promise<string> };
}
