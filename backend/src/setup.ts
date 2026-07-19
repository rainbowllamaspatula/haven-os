/**
 * First-run setup — the Haven wizard's server half (19 Jul 2026 brief).
 *
 * A virgin install boots to setup instead of the front door. Virgin means:
 * production, no VALE_PASSWORD env secret (our install always has one — it
 * can never present as virgin), and no `auth.password` row in preferences.
 * The wizard collects the minimum path ruled by Elle (Option B): app
 * password → Anthropic key → identity (names, static prompt, optional voice)
 * → normal boot.
 *
 * auth.ts is UNTOUCHED per AGENTS.md: this module only decides what the
 * expected password IS. Where the env secret exists it is used exactly as
 * before, byte-for-byte the same code path; where it doesn't (a Haven
 * install), the wizard stores a PBKDF2-SHA256 hash as a preferences row and
 * login compares digests through auth.ts's own constant-time check.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { passwordMatches } from "./auth";
import { ensureStoreCoordinates, saveKey } from "./fusebox-keys";
import { fetchWithTimeout } from "./http";
import { validateIdentityProfile } from "./identity";

const PBKDF2_ITERATIONS = 100_000;

export type StoredPassword = {
	algo: "pbkdf2-sha256";
	iterations: number;
	/** hex */
	salt: string;
	/** hex */
	hash: string;
};

const toHex = (buf: ArrayBuffer | Uint8Array): string =>
	[...new Uint8Array(buf as ArrayBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function deriveHex(password: string, saltHex: string, iterations: number): Promise<string> {
	const salt = new Uint8Array(saltHex.match(/.{2}/g)?.map((h) => parseInt(h, 16)) ?? []);
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt, iterations },
		key,
		256,
	);
	return toHex(bits);
}

/** Hash a new password for storage (wizard, one-time). */
export async function hashPassword(password: string): Promise<StoredPassword> {
	const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
	return {
		algo: "pbkdf2-sha256",
		iterations: PBKDF2_ITERATIONS,
		salt,
		hash: await deriveHex(password, salt, PBKDF2_ITERATIONS),
	};
}

/** The stored hash row, or null when absent (env-password installs, virgin installs). */
export async function loadStoredPassword(supabase: SupabaseClient): Promise<StoredPassword | null> {
	const { data, error } = await supabase
		.from("preferences")
		.select("value")
		.eq("key", "auth.password")
		.maybeSingle();
	if (error) throw new Error(`auth.password load failed: ${error.message}`);
	const v = data?.value as Partial<StoredPassword> | null;
	if (!v || v.algo !== "pbkdf2-sha256" || !v.salt || !v.hash || !v.iterations) return null;
	return v as StoredPassword;
}

/**
 * The one password check both gates use (front door + Fuse Box side gate).
 * Env secret first — our install's path, unchanged in behaviour and in the
 * function that does the comparing — then the stored hash. Digest-vs-digest
 * comparison goes through auth.ts's constant-time passwordMatches, so timing
 * discipline is inherited, not re-implemented.
 */
export async function checkHousePassword(
	env: Env,
	supabase: SupabaseClient,
	input: unknown,
): Promise<boolean> {
	if (env.VALE_PASSWORD) return passwordMatches(input, env.VALE_PASSWORD);
	const stored = await loadStoredPassword(supabase);
	if (!stored || typeof input !== "string") return false;
	const derived = await deriveHex(input, stored.salt, stored.iterations);
	return passwordMatches(derived, stored.hash);
}

/**
 * Whether this install still needs first-run setup. Only ever true in
 * production with no env password AND no stored hash — the sandbox stays
 * open, and our install (env password set) can never trip it.
 */
export async function setupRequired(env: Env, supabase: SupabaseClient): Promise<boolean> {
	if (env.VALE_PASSWORD) return false;
	const stored = await loadStoredPassword(supabase);
	return stored === null;
}

// The wizard surface's own CORS block (index.ts's constant would be a cycle).
const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET,POST,OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

const json = (body: unknown, status = 200): Response =>
	Response.json(body, { status, headers: CORS });

/**
 * The /api/setup surface, live ONLY while the install is virgin (the caller
 * guarantees that — see index.ts's gate). Returns null for anything it
 * doesn't own so the caller can fall through to its own handling.
 *
 *  - POST /api/setup/test-key — probe a pasted Anthropic key (models list;
 *    free, never a billable call) before anything is stored.
 *  - POST /api/setup/complete — the whole minimum path, ordered so every
 *    fallible step runs BEFORE the password write: the password is the
 *    virginity flip, so a failure anywhere leaves the install virgin and the
 *    wizard retryable.
 */
export async function handleSetupRequest(
	request: Request,
	url: URL,
	env: Env,
	supabase: SupabaseClient,
): Promise<Response | null> {
	if (request.method === "POST" && url.pathname === "/api/setup/test-key") {
		let body: { anthropic_key?: unknown };
		try {
			body = await request.json();
		} catch {
			return json({ ok: false, error: "Body must be JSON." }, 400);
		}
		const key = typeof body.anthropic_key === "string" ? body.anthropic_key.trim() : "";
		if (!key) return json({ ok: false, error: "Paste the Anthropic key first." }, 400);
		try {
			const res = await fetchWithTimeout(
				"https://api.anthropic.com/v1/models",
				{ headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } },
				{ service: "keytest" },
			);
			return res.ok
				? json({ ok: true, detail: "Anthropic accepted the key." })
				: json({ ok: false, detail: `Anthropic answered ${res.status} — the key looks wrong.` });
		} catch (e) {
			return json({ ok: false, detail: `Anthropic unreachable: ${(e as Error).message}` });
		}
	}

	if (request.method === "POST" && url.pathname === "/api/setup/complete") {
		let body: {
			password?: unknown;
			anthropic_key?: unknown;
			house_name?: unknown;
			companion_name?: unknown;
			user_name?: unknown;
			companion_role?: unknown;
			timezone?: unknown;
			static_prompt?: unknown;
			voice_id?: unknown;
		};
		try {
			body = await request.json();
		} catch {
			return json({ ok: false, error: "Body must be JSON." }, 400);
		}

		const password = typeof body.password === "string" ? body.password : "";
		if (password.length < 8) {
			return json({ ok: false, error: "The password needs at least 8 characters." }, 400);
		}
		const anthropicKey = typeof body.anthropic_key === "string" ? body.anthropic_key.trim() : "";
		if (!anthropicKey) {
			return json({ ok: false, error: "The Anthropic key is required — it's how the companion talks." }, 400);
		}
		const staticPrompt = typeof body.static_prompt === "string" ? body.static_prompt.trim() : "";
		if (!staticPrompt) {
			return json({ ok: false, error: "The companion's prompt is required — paste it in." }, 400);
		}
		const profileCheck = validateIdentityProfile({
			house_name: body.house_name,
			companion_name: body.companion_name,
			user_name: body.user_name,
			companion_role: body.companion_role,
			timezone: body.timezone,
		});
		if (!profileCheck.ok) return json({ ok: false, error: profileCheck.error }, 400);
		const voiceId = typeof body.voice_id === "string" ? body.voice_id.trim() : "";

		// 1. Store coordinates (account + store ids) — discovered via the deploy
		//    token and persisted, so the keys circuit can write from now on.
		const coords = await ensureStoreCoordinates(env, supabase);
		if (!coords.ok) return json({ ok: false, error: coords.error }, 502);

		// 2. The Anthropic key, through the same machinery the keys circuit uses.
		const savedKey = await saveKey(env, supabase, "ANTHROPIC_API_KEY", anthropicKey);
		if (!savedKey.ok) return json({ ok: false, error: savedKey.error }, 502);

		// 3. Identity profile.
		{
			const { error } = await supabase.from("preferences").upsert(
				{ key: "identity.profile", value: profileCheck.profile },
				{ onConflict: "key" },
			);
			if (error) return json({ ok: false, error: `Couldn't store the identity: ${error.message}` }, 502);
		}

		// 4. The static prompt — same append-only RPC the Identity circuit uses.
		{
			const { error } = await supabase.rpc("save_prompt_version", {
				p_content: staticPrompt,
				p_note: "v1 — first-run wizard",
			});
			if (error) return json({ ok: false, error: `Couldn't store the prompt: ${error.message}` }, 502);
		}

		// 5. Voice identity, only if offered (skippable per the brief).
		if (voiceId) {
			const { error } = await supabase.from("preferences").upsert(
				{ key: "identity.voice", value: { voice_id: voiceId, model_id: "eleven_v3" } },
				{ onConflict: "key" },
			);
			if (error) return json({ ok: false, error: `Couldn't store the voice: ${error.message}` }, 502);
		}

		// 6. The password — last, because it flips the install to configured.
		const stored = await storePassword(supabase, password);
		if (!stored.ok) return json({ ok: false, error: stored.error }, 400);

		return json({ ok: true });
	}

	return null;
}

/** Persist the wizard's password. Refuses to overwrite — setup runs once. */
export async function storePassword(
	supabase: SupabaseClient,
	password: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (password.length < 8) return { ok: false, error: "The password needs at least 8 characters." };
	if (password.length > 200) return { ok: false, error: "That password is implausibly long." };
	const existing = await loadStoredPassword(supabase);
	if (existing) return { ok: false, error: "A password is already set — setup has already run." };
	const hashed = await hashPassword(password);
	const { error } = await supabase
		.from("preferences")
		.insert({ key: "auth.password", value: hashed });
	if (error) return { ok: false, error: `Couldn't store the password: ${error.message}` };
	return { ok: true };
}
