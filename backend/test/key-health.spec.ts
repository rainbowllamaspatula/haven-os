import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordKeyHealth, readKeyHealth, keyCapabilities } from "../src/key-health";

// The tested-and-passed flags (F7/F8, scratch-account run 26 Jul 2026): the
// only readiness signal that reflects reality is a real API test that passed,
// recorded in the database. These tests pin the flag round-trip and the
// capability rule: recorded pass AND still present in the store.

const dbWith = (
	healthRows: Array<{ key: string; value: unknown }>,
	upserts: unknown[] = [],
): SupabaseClient =>
	({
		from: () => ({
			select: () => ({
				like: async () => ({ data: healthRows, error: null }),
			}),
			upsert: async (v: unknown) => {
				upserts.push(v);
				return { error: null };
			},
		}),
	}) as unknown as SupabaseClient;

// The binding shape secrets.ts requires ({ get }); absence = no binding.
const bindingOf = (value: string) => ({ get: async () => value });

describe("recordKeyHealth / readKeyHealth", () => {
	it("records a verdict as a keys.health.<NAME> preferences row and reads it back by name", async () => {
		const upserts: Array<{ key: string; value: { ok: boolean; tested_at: string; detail?: string } }> = [];
		await recordKeyHealth(dbWith([], upserts), "ANTHROPIC_API_KEY", true, "Anthropic accepted the key.");
		expect(upserts).toHaveLength(1);
		expect(upserts[0].key).toBe("keys.health.ANTHROPIC_API_KEY");
		expect(upserts[0].value.ok).toBe(true);
		expect(upserts[0].value.tested_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

		const read = await readKeyHealth(dbWith([upserts[0]]));
		expect(read.get("ANTHROPIC_API_KEY")).toMatchObject({ ok: true });
	});

	it("records failures too — a failing key must read as failing, not as stale-passing", async () => {
		const upserts: Array<{ key: string; value: { ok: boolean } }> = [];
		await recordKeyHealth(dbWith([], upserts), "NOTION_TOKEN", false, "Notion answered 401.");
		expect(upserts[0].value.ok).toBe(false);
	});

	it("ignores malformed rows rather than trusting them", async () => {
		const read = await readKeyHealth(
			dbWith([{ key: "keys.health.GETIMG_API_KEY", value: { nonsense: true } }]),
		);
		expect(read.has("GETIMG_API_KEY")).toBe(false);
	});
});

describe("keyCapabilities - recorded pass AND present in the store", () => {
	const pass = (name: string) => ({
		key: `keys.health.${name}`,
		value: { ok: true, tested_at: "2026-07-26T03:00:00Z" },
	});

	it("a key is a capability only with a recorded pass and a live binding value", async () => {
		const env = {
			ELEVENLABS_API_KEY: bindingOf("real-key"),
			GETIMG_API_KEY: bindingOf("also-real"),
		} as unknown as Env;
		const caps = await keyCapabilities(env, dbWith([pass("ELEVENLABS_API_KEY")]));
		// Pass + present = capability.
		expect(caps.ELEVENLABS_API_KEY).toBe(true);
		// Present but never tested = NOT a capability (F7: the scratch install's
		// seven "UNSET" placeholders all existed; none were real).
		expect(caps.GETIMG_API_KEY).toBe(false);
		// Neither = not a capability.
		expect(caps.NOTION_TOKEN).toBe(false);
	});

	it("a recorded pass without the secret (deleted after testing) goes dark, not stale-lit", async () => {
		const caps = await keyCapabilities({} as unknown as Env, dbWith([pass("ELEVENLABS_API_KEY")]));
		expect(caps.ELEVENLABS_API_KEY).toBe(false);
	});

	it("a health-read failure degrades to all-false — honest dark, never a claimed capability", async () => {
		const broken = {
			from: () => ({
				select: () => ({
					like: async () => ({ data: null, error: { message: "boom" } }),
				}),
			}),
		} as unknown as SupabaseClient;
		const caps = await keyCapabilities(
			{ ELEVENLABS_API_KEY: bindingOf("real-key") } as unknown as Env,
			broken,
		);
		expect(Object.values(caps).every((v) => v === false)).toBe(true);
	});
});
