/**
 * Tested-and-passed key health — the honest half of readiness (scratch-run
 * findings F7 + F8, 26 Jul 2026).
 *
 * The Secrets Store can only say a secret EXISTS — and on a button-deployed
 * install every secret exists from minute one, holding whatever placeholder
 * the deploy screen was given ("UNSET", seven times over, on the scratch
 * run). Existence proves nothing, and the store is write-only by design
 * (18 Jul ruling, not reversed), so no reader can inspect a value. The only
 * signal that reflects reality is a real API test that PASSED — recorded
 * here, in the database, by the same test path the circuit's Test button
 * already runs.
 *
 * Writers: the wizard's complete step, the keys circuit's save (which now
 * auto-tests) and its Test button — every test records its verdict, pass or
 * fail. Readers: /api/readiness, the prompt's awareness blocks, the tool
 * roster. A key with no recorded pass is not offered, so F7's false
 * positives (readiness lighting rooms off placeholder secrets, the
 * companion claiming a voice he doesn't have) and F8's false negatives
 * (the circuit reading its own bookkeeping instead of reality) die
 * together: both readers now share one signal, and that signal is earned.
 *
 * Our install's seven flags are seeded by migration — the keys were all
 * live-verified in production long before this module existed.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { hasSecret, type ManagedKeyName } from "./secrets";

export type KeyHealth = { ok: boolean; tested_at: string; detail?: string };

const PREFIX = "keys.health.";

const MANAGED: ManagedKeyName[] = [
	"ANTHROPIC_API_KEY",
	"ELEVENLABS_API_KEY",
	"GETIMG_API_KEY",
	"HA_MCP_URL",
	"HA_TOKEN",
	"NOTION_TOKEN",
	"OPENROUTER_API_KEY",
];

/**
 * Record a test verdict for a key. Failures are recorded too — "failing its
 * test" is more honest than a stale pass. Throws on a write failure so the
 * caller decides what a lost flag means (the wizard treats it as fatal and
 * stays retryable; the circuit reports the verdict with a warning).
 */
export async function recordKeyHealth(
	supabase: SupabaseClient,
	name: string,
	ok: boolean,
	detail: string,
): Promise<void> {
	const { error } = await supabase.from("preferences").upsert(
		{ key: `${PREFIX}${name}`, value: { ok, tested_at: new Date().toISOString(), detail } },
		{ onConflict: "key" },
	);
	if (error) throw new Error(`Couldn't record the ${name} test result: ${error.message}`);
}

/** Every recorded verdict, keyed by registry/binding name. */
export async function readKeyHealth(
	supabase: SupabaseClient,
): Promise<Map<string, KeyHealth>> {
	const { data, error } = await supabase
		.from("preferences")
		.select("key, value")
		.like("key", `${PREFIX}%`);
	if (error) throw new Error(`key health read failed: ${error.message}`);
	const map = new Map<string, KeyHealth>();
	for (const row of data ?? []) {
		const v = row.value as Partial<KeyHealth> | null;
		if (v && typeof v.ok === "boolean" && typeof v.tested_at === "string") {
			map.set(String(row.key).slice(PREFIX.length), v as KeyHealth);
		}
	}
	return map;
}

/**
 * The seven managed keys as capabilities: a recorded PASS and the secret
 * still present in the store, together. The flag is the truth signal; the
 * binding probe is belt and braces so a secret deleted after a pass goes
 * dark instead of lighting a dead room. A health-read hiccup degrades to
 * all-false — an honestly dark house, never a claimed capability.
 */
export async function keyCapabilities(
	env: Env,
	supabase: SupabaseClient,
): Promise<Record<ManagedKeyName, boolean>> {
	let health: Map<string, KeyHealth>;
	try {
		health = await readKeyHealth(supabase);
	} catch (err) {
		console.error("key health read failed (degrading to no capabilities):", err);
		health = new Map();
	}
	const present = await Promise.all(MANAGED.map((n) => hasSecret(env, n)));
	return Object.fromEntries(
		MANAGED.map((n, i) => [n, (health.get(n)?.ok ?? false) && present[i]]),
	) as Record<ManagedKeyName, boolean>;
}
