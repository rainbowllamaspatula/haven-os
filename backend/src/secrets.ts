/**
 * The one door to the managed keys — Phase 2B of the Fuse Box brief (v0.3).
 *
 * The six outbound keys live in Cloudflare Secrets Store and reach the Worker
 * as per-name bindings (wrangler.jsonc `secrets_store_secrets`): async
 * handles, not strings. This accessor is the ONLY place allowed to call
 * `.get()` — no direct binding reads anywhere else, so the rules live here:
 *
 *  - Per-request, always. No module-scope caching of values or of clients
 *    built from them: Cloudflare's docs are explicit that isolates can be
 *    reused across binding changes, so a cached value survives a rotation —
 *    the stale-key bug acceptance test 4 exists to catch. If caching is ever
 *    added it needs an invalidation story, not an assumption.
 *  - Fail LOUD, by name. A missing secret throws naming the key and where to
 *    fix it (the Fuse Box keys circuit). Never a fallback to env — a silent
 *    bridge hides a broken migration until 11pm; an error names it at once.
 *
 * Wrangler-resident secrets (the locks and the plumbing: VALE_PASSWORD,
 * SESSION_SECRET, GALLERY_MCP_TOKEN, SUPABASE_SERVICE_ROLE_KEY, R2 creds,
 * Gmail/Spotify, CF_SECRETS_STORE_TOKEN) stay plain env strings and do NOT
 * come through here — per the inbound-credential rule, the Fuse Box never
 * manages a lock, so a lock never lives in the store.
 */

export type ManagedKeyName =
	| "ANTHROPIC_API_KEY"
	| "ELEVENLABS_API_KEY"
	| "GETIMG_API_KEY"
	| "HA_MCP_URL"
	| "HA_TOKEN"
	| "NOTION_TOKEN"
	| "OPENROUTER_API_KEY";

/** The shape a secrets_store_secrets binding exposes at runtime. */
type SecretBinding = { get(): Promise<string> };

export async function getSecret(env: Env, name: ManagedKeyName): Promise<string> {
	const binding = env[name] as unknown as SecretBinding | string | undefined;
	// A plain string here means the binding didn't happen (an old deploy, or a
	// test env built pre-cutover) — refuse rather than quietly read it: the
	// no-silent-fallback rule is exactly about this seam.
	if (!binding || typeof binding === "string" || typeof binding.get !== "function") {
		throw new Error(
			`${name} has no Secrets Store binding — wrangler.jsonc is missing its secrets_store_secrets entry (or this deploy predates the cutover).`,
		);
	}
	let value: string | null = null;
	try {
		value = await binding.get();
	} catch {
		value = null;
	}
	if (!value) {
		throw new Error(
			`${name} is missing from the Secrets Store — open the Fuse Box keys circuit and set it.`,
		);
	}
	return value;
}

/**
 * Whether a managed key is present and non-empty — the graceful-degradation
 * probe (Haven fork). Same per-request, no-cache rules as getSecret; the only
 * difference is that absence is an answer here, not an error. Rooms and the
 * prompt's capability blocks ask this so an unconfigured install degrades
 * honestly instead of erroring.
 */
export async function hasSecret(env: Env, name: ManagedKeyName): Promise<boolean> {
	try {
		await getSecret(env, name);
		return true;
	} catch {
		return false;
	}
}
