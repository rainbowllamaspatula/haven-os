import { describe, it, expect, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveStoreConfig, listKeys, saveKey, testKey, KEY_REGISTRY } from "../src/fusebox-keys";

// The three pieces the store client needs. Values are inert test strings.
const ENV = {
	CF_ACCOUNT_ID: "acct-1",
	CF_STORE_ID: "store-1",
	CF_SECRETS_STORE_TOKEN: "token-1",
} as unknown as Env;

// A preferences read that finds nothing — the Haven-fork fallback path when an
// env id is missing. Rows can be supplied for the config-resolution test;
// health rows (keys.health.*) for the tested-flag merge (F7/F8).
const dbWithRows = (
	rows: Array<{ key: string; value: unknown }>,
	healthRows: Array<{ key: string; value: unknown }> = [],
): SupabaseClient =>
	({
		from: () => ({
			select: () => ({
				in: async () => ({ data: rows, error: null }),
				like: async () => ({ data: healthRows, error: null }),
			}),
		}),
	}) as unknown as SupabaseClient;
const EMPTY_DB = dbWithRows([]);

const envelope = (result: unknown, success = true, errors: Array<{ message: string }> = []) =>
	new Response(JSON.stringify({ success, result, errors }), {
		status: success ? 200 : 400,
		headers: { "Content-Type": "application/json" },
	});

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	const spy = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
		handler(String(url), init),
	);
	vi.stubGlobal("fetch", spy);
	return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe("the registry", () => {
	it("holds exactly the seven managed outbound keys — no locks, no inbound credentials", () => {
		expect(KEY_REGISTRY.map((k) => k.name)).toEqual([
			"ANTHROPIC_API_KEY",
			"ELEVENLABS_API_KEY",
			"GETIMG_API_KEY",
			"HA_MCP_URL",
			"HA_TOKEN",
			"NOTION_TOKEN",
			"OPENROUTER_API_KEY",
		]);
		// The inbound-credential rule, as a test: these names must never appear.
		for (const forbidden of ["VALE_PASSWORD", "SESSION_SECRET", "GALLERY_MCP_TOKEN"]) {
			expect(KEY_REGISTRY.some((k) => k.name === forbidden)).toBe(false);
		}
	});

	it("names are store-legal and canonical: no spaces (API rule), uppercase (the binding-name convention, F6)", () => {
		for (const k of KEY_REGISTRY) {
			expect(k.name).not.toMatch(/\s/);
			expect(k.name).toBe(k.name.toUpperCase());
		}
	});
});

describe("resolveStoreConfig - env first, preferences second, fail loud by name", () => {
	it.each([
		["CF_ACCOUNT_ID", { ...ENV, CF_ACCOUNT_ID: "" }],
		["CF_STORE_ID", { ...ENV, CF_STORE_ID: "" }],
		["CF_SECRETS_STORE_TOKEN", { ...ENV, CF_SECRETS_STORE_TOKEN: "" }],
	])("names %s when it is missing everywhere", async (name, env) => {
		const cfg = await resolveStoreConfig(env as unknown as Env, EMPTY_DB);
		expect(cfg).toEqual({ missing: name });
	});

	it("returns the config when all three pieces exist in env", async () => {
		expect(await resolveStoreConfig(ENV, EMPTY_DB)).toEqual({
			accountId: "acct-1",
			storeId: "store-1",
			token: "token-1",
		});
	});

	it("falls back to the cf.* preferences rows when the env vars are absent (Haven install)", async () => {
		const db = dbWithRows([
			{ key: "cf.account_id", value: "acct-row" },
			{ key: "cf.store_id", value: "store-row" },
		]);
		const cfg = await resolveStoreConfig(
			{ ...ENV, CF_ACCOUNT_ID: "", CF_STORE_ID: "" } as unknown as Env,
			db,
		);
		expect(cfg).toEqual({ accountId: "acct-row", storeId: "store-row", token: "token-1" });
	});
});

describe("listKeys - registry merged with store metadata", () => {
	it("marks stored keys set (with modified) and absent keys not set — legacy lowercase rows match", async () => {
		stubFetch(() =>
			envelope([
				{ id: "id-a", name: "anthropic_api_key", modified: "2026-07-18T02:00:00Z" },
				{ id: "id-x", name: "some_unmanaged_secret", modified: "2026-07-01T00:00:00Z" },
			]),
		);
		const listed = await listKeys(ENV, EMPTY_DB);
		expect(listed.ok).toBe(true);
		if (!listed.ok) return;
		expect(listed.keys).toHaveLength(KEY_REGISTRY.length);
		const anthropic = listed.keys.find((k) => k.name === "ANTHROPIC_API_KEY");
		expect(anthropic).toMatchObject({
			set: true,
			modified: "2026-07-18T02:00:00Z",
			// The actual store row name is reported, whatever its case.
			secret_name: "anthropic_api_key",
		});
		const notion = listed.keys.find((k) => k.name === "NOTION_TOKEN");
		expect(notion).toMatchObject({ set: false, modified: null, secret_name: "NOTION_TOKEN" });
		// Unmanaged store rows never leak into the registry view.
		expect(listed.keys.some((k) => k.secret_name === "some_unmanaged_secret")).toBe(false);
	});

	it("matches button-created UPPERCASE rows too (F6: one key, either case)", async () => {
		stubFetch(() => envelope([{ id: "id-a", name: "ANTHROPIC_API_KEY", modified: "2026-07-26T02:00:00Z" }]));
		const listed = await listKeys(ENV, EMPTY_DB);
		expect(listed.ok).toBe(true);
		if (!listed.ok) return;
		const anthropic = listed.keys.find((k) => k.name === "ANTHROPIC_API_KEY");
		expect(anthropic).toMatchObject({ set: true, secret_name: "ANTHROPIC_API_KEY" });
	});

	it("merges the recorded test verdict; an untested key reads tested: null (F8)", async () => {
		stubFetch(() => envelope([{ id: "id-a", name: "ANTHROPIC_API_KEY" }]));
		const health = [
			{
				key: "keys.health.ANTHROPIC_API_KEY",
				value: { ok: true, tested_at: "2026-07-26T03:00:00Z", detail: "Anthropic accepted the key." },
			},
		];
		const listed = await listKeys(ENV, dbWithRows([], health));
		expect(listed.ok).toBe(true);
		if (!listed.ok) return;
		const anthropic = listed.keys.find((k) => k.name === "ANTHROPIC_API_KEY");
		expect(anthropic?.tested).toMatchObject({ ok: true, tested_at: "2026-07-26T03:00:00Z" });
		// Set in the store but never tested: exactly the state the scratch run's
		// placeholder secrets were in — visible as unproven, not as ready.
		const notion = listed.keys.find((k) => k.name === "NOTION_TOKEN");
		expect(notion?.tested).toBeNull();
	});

	it("fails loud with the missing config name, without calling the API", async () => {
		const spy = stubFetch(() => envelope([]));
		const listed = await listKeys({ ...ENV, CF_STORE_ID: "" } as unknown as Env, EMPTY_DB);
		expect(listed).toEqual({ ok: false, error: "The keys circuit is missing CF_STORE_ID." });
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("saveKey - fixed registry, update-by-id, create-with-scopes", () => {
	it("refuses a name outside the registry without touching the API", async () => {
		const spy = stubFetch(() => envelope([]));
		const saved = await saveKey(ENV, EMPTY_DB, "GALLERY_MCP_TOKEN", "sneaky");
		expect(saved).toEqual({ ok: false, error: "GALLERY_MCP_TOKEN is not a managed key." });
		expect(spy).not.toHaveBeenCalled();
	});

	it("refuses an empty value", async () => {
		const saved = await saveKey(ENV, EMPTY_DB, "NOTION_TOKEN", "   ");
		expect(saved).toEqual({ ok: false, error: "A new value is required." });
	});

	it("PATCHes an existing secret by id, with the pasted value trimmed", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		stubFetch((url, init) => {
			calls.push({ url, init });
			if (!init?.method || init.method === "GET") {
				return envelope([{ id: "id-n", name: "notion_token", modified: "x" }]);
			}
			return envelope({ id: "id-n", name: "notion_token" });
		});
		const saved = await saveKey(ENV, EMPTY_DB, "NOTION_TOKEN", "  secret-value\n");
		expect(saved).toEqual({ ok: true, created: false });
		const patch = calls.find((c) => c.init?.method === "PATCH");
		expect(patch).toBeDefined();
		expect(patch!.url).toContain("/secrets_store/stores/store-1/secrets/id-n");
		expect(JSON.parse(String(patch!.init!.body))).toEqual({ value: "secret-value" });
	});

	it("PATCHes a button-created UPPERCASE secret instead of creating a duplicate (F5)", async () => {
		// The scratch-run crash: the store held ANTHROPIC_API_KEY (the deploy
		// button's casing), the app looked for lowercase, found "nothing", tried
		// to create — and the store's case-insensitive uniqueness rejected it.
		// The fix: any case-variant is THE secret, and is updated in place.
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		stubFetch((url, init) => {
			calls.push({ url, init });
			if (!init?.method || init.method === "GET") {
				return envelope([{ id: "id-A", name: "ANTHROPIC_API_KEY", modified: "x" }]);
			}
			return envelope({ id: "id-A", name: "ANTHROPIC_API_KEY" });
		});
		const saved = await saveKey(ENV, EMPTY_DB, "ANTHROPIC_API_KEY", "sk-ant-real");
		expect(saved).toEqual({ ok: true, created: false });
		expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
		const patch = calls.find((c) => c.init?.method === "PATCH");
		expect(patch!.url).toContain("/secrets/id-A");
	});

	it("POSTs a new secret as an array, workers scope, under the binding name, when genuinely absent", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		stubFetch((url, init) => {
			calls.push({ url, init });
			if (!init?.method || init.method === "GET") return envelope([]);
			return envelope([{ id: "id-new", name: "GETIMG_API_KEY" }]);
		});
		const saved = await saveKey(ENV, EMPTY_DB, "GETIMG_API_KEY", "key-123");
		expect(saved).toEqual({ ok: true, created: true });
		const post = calls.find((c) => c.init?.method === "POST");
		expect(post).toBeDefined();
		expect(JSON.parse(String(post!.init!.body))).toEqual([
			{ name: "GETIMG_API_KEY", value: "key-123", scopes: ["workers"] },
		]);
	});

	it("surfaces the API's own error message on a failed write", async () => {
		stubFetch((url, init) => {
			if (!init?.method || init.method === "GET") {
				return envelope([{ id: "id-h", name: "ha_token" }]);
			}
			return envelope(null, false, [{ message: "secret value too large" }]);
		});
		const saved = await saveKey(ENV, EMPTY_DB, "HA_TOKEN", "v");
		expect(saved).toEqual({ ok: false, error: "secret value too large" });
	});
});

describe("testKey", () => {
	it("refuses a name outside the registry", async () => {
		const tested = await testKey(ENV, "SUPABASE_SERVICE_ROLE_KEY");
		expect(tested).toEqual({ ok: false, detail: "SUPABASE_SERVICE_ROLE_KEY is not a managed key." });
	});

	// Post-cutover, testKey resolves values through the binding — tests stub the
	// binding shape ({ get }), exactly what secrets.ts requires. A plain string
	// must be REFUSED (the no-silent-fallback seam), tested last.
	const bindingOf = (value: string) => ({ get: async () => value });

	it("reports a rejected key honestly, naming the service and status", async () => {
		stubFetch(() => new Response("unauthorized", { status: 401 }));
		const tested = await testKey(
			{ ...ENV, NOTION_TOKEN: bindingOf("bad"), NOTION_VERSION: "2025-09-03" } as unknown as Env,
			"NOTION_TOKEN",
		);
		expect(tested.ok).toBe(false);
		expect(tested.detail).toContain("Notion");
		expect(tested.detail).toContain("401");
	});

	it("reports an accepted key", async () => {
		stubFetch(() => new Response("{}", { status: 200 }));
		const tested = await testKey(
			{ ...ENV, ELEVENLABS_API_KEY: bindingOf("good") } as unknown as Env,
			"ELEVENLABS_API_KEY",
		);
		expect(tested).toEqual({ ok: true, detail: "ElevenLabs accepted the key." });
	});

	it("refuses a pre-cutover plain-string env value rather than quietly reading it", async () => {
		const spy = stubFetch(() => new Response("{}", { status: 200 }));
		const tested = await testKey(
			{ ...ENV, ELEVENLABS_API_KEY: "a-plain-string" } as unknown as Env,
			"ELEVENLABS_API_KEY",
		);
		expect(tested.ok).toBe(false);
		expect(tested.detail).toContain("no Secrets Store binding");
		expect(spy).not.toHaveBeenCalled();
	});
});
