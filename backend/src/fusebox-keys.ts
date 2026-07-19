/**
 * The Fuse Box keys circuit — Phase 2 of the v0.3 brief.
 *
 * A FIXED registry of managed keys over Cloudflare Secrets Store. The store is
 * write-only by design: values go in through the REST API here and are only
 * ever decrypted by the Worker runtime — no readback path exists, which is the
 * architecture (Option C), not a limitation. This module talks to the API with
 * CF_SECRETS_STORE_TOKEN, an Edit-scoped Secrets-Store-only token whose worst
 * leak case is overwriting outbound keys. Inbound credentials (VALE_PASSWORD,
 * SESSION_SECRET, GALLERY_MCP_TOKEN) are deliberately NOT in this registry —
 * the inbound-credential rule: the Fuse Box never manages a secret that gates
 * the Fuse Box, and never manages a lock (overwrite on a lock = access grant).
 *
 * The registry is fixed on purpose (brief: "will bite" #2): each secret name
 * needs a binding entry in wrangler.jsonc, so arbitrary runtime names can't
 * work — the UI edits values of known keys, never invents keys.
 *
 * API shapes verified against live docs 18 Jul 2026:
 *   list    GET    /accounts/{a}/secrets_store/stores/{s}/secrets
 *   create  POST   same path — body is an ARRAY of {name, value, scopes[]};
 *                  scopes must include "workers" or the binding deploy rejects
 *   update  PATCH  .../secrets/{secret_id} — by ID, never by name
 *
 * Post-cutover: consumers and test buttons alike resolve values through
 * secrets.ts (the binding), so a test exercises exactly what the house runs
 * on — the store value — and a rotation is testable the second it saves.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchWithTimeout } from "./http";
import { haServer, pingMcp } from "./mcp";
import { getSecret } from "./secrets";

export type KeyRegistryEntry = {
	/** Registry + env/binding name, e.g. "ANTHROPIC_API_KEY". */
	name: string;
	/** Secrets Store secret name, e.g. "anthropic_api_key". No spaces — API rule. */
	secretName: string;
	/** One line of who-uses-it, for the UI row. */
	consumer: string;
	/** Whether a cheap, safe test exists (never a billable call). */
	testable: boolean;
};

/** The managed set — the six outbound keys from the v0.3 inventory. */
export const KEY_REGISTRY: KeyRegistryEntry[] = [
	{
		name: "ANTHROPIC_API_KEY",
		secretName: "anthropic_api_key",
		consumer: "the brain · voice render · Polish · Post Box titles",
		testable: true,
	},
	{
		name: "ELEVENLABS_API_KEY",
		secretName: "elevenlabs_api_key",
		consumer: "voice notes",
		testable: true,
	},
	{
		name: "GETIMG_API_KEY",
		secretName: "getimg_api_key",
		consumer: "the Gallery",
		testable: true,
	},
	{
		name: "HA_MCP_URL",
		secretName: "ha_mcp_url",
		consumer: "the Hearth · home tools (MCP endpoint)",
		testable: true,
	},
	{
		name: "HA_TOKEN",
		secretName: "ha_token",
		consumer: "the Hearth · home tools",
		testable: true,
	},
	{
		name: "NOTION_TOKEN",
		secretName: "notion_token",
		consumer: "Workshop · journal · Post Box tasks",
		testable: true,
	},
	{
		// The seventh key (Haven fork, 19 Jul 2026): the embed call moved from
		// the Supabase Edge Function into the Worker, so the OpenRouter key is
		// managed here like every other outbound key — enterable in the wizard,
		// rotatable deploy-free. Memory's re-embed-or-don't-save rule rides on it.
		name: "OPENROUTER_API_KEY",
		secretName: "openrouter_api_key",
		consumer: "memory embeddings (retrieval + write_memory)",
		testable: true,
	},
];

const byName = new Map(KEY_REGISTRY.map((e) => [e.name, e]));

/** Longest plausible secret value — a paste guard, not a real limit. */
const MAX_VALUE_LENGTH = 5000;

type StoreConfig = { accountId: string; storeId: string; token: string };

/**
 * Fail loud, by name (brief: no silent fallback, ever): the circuit refuses to
 * run with a missing piece rather than half-working.
 *
 * Resolution order (Haven fork): env vars first — unchanged behaviour wherever
 * they're set — then the `cf.account_id` / `cf.store_id` preferences rows the
 * template installs carry (written by the wizard's bootstrap, or seeded by
 * migration on ours). The token is always env: it's an inbound-adjacent
 * credential and never lives in a row.
 */
export async function resolveStoreConfig(
	env: Env,
	supabase: SupabaseClient,
): Promise<StoreConfig | { missing: string }> {
	if (!env.CF_SECRETS_STORE_TOKEN) return { missing: "CF_SECRETS_STORE_TOKEN" };
	let accountId = env.CF_ACCOUNT_ID || "";
	let storeId = env.CF_STORE_ID || "";
	if (!accountId || !storeId) {
		const { data, error } = await supabase
			.from("preferences")
			.select("key, value")
			.in("key", ["cf.account_id", "cf.store_id"]);
		if (error) return { missing: `cf ids (read failed: ${error.message})` };
		for (const row of data ?? []) {
			const v = typeof row.value === "string" ? row.value : "";
			if (row.key === "cf.account_id" && !accountId) accountId = v;
			if (row.key === "cf.store_id" && !storeId) storeId = v;
		}
	}
	if (!accountId) return { missing: "CF_ACCOUNT_ID" };
	if (!storeId) return { missing: "CF_STORE_ID" };
	return { accountId, storeId, token: env.CF_SECRETS_STORE_TOKEN };
}

const API_BASE = "https://api.cloudflare.com/client/v4";

type CfEnvelope<T> = {
	success?: boolean;
	result?: T;
	errors?: Array<{ code?: number; message?: string }>;
};

type StoreSecretRow = {
	id: string;
	name: string;
	status?: string;
	comment?: string;
	created?: string;
	modified?: string;
};

async function storeFetch<T>(
	cfg: StoreConfig,
	path: string,
	init?: RequestInit,
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
	const res = await fetchWithTimeout(
		`${API_BASE}/accounts/${cfg.accountId}/secrets_store/stores/${cfg.storeId}${path}`,
		{
			...init,
			headers: {
				Authorization: `Bearer ${cfg.token}`,
				"Content-Type": "application/json",
				...(init?.headers ?? {}),
			},
		},
		{ service: "cloudflare" },
	);
	let body: CfEnvelope<T> | null = null;
	try {
		body = (await res.json()) as CfEnvelope<T>;
	} catch {
		// Non-JSON error body; fall through to the status line below.
	}
	if (!res.ok || body?.success === false) {
		const detail = body?.errors?.map((e) => e.message).filter(Boolean).join("; ");
		return { ok: false, error: detail || `Secrets Store API answered ${res.status}.` };
	}
	return { ok: true, result: (body?.result ?? ([] as unknown)) as T };
}

export type KeyStatusRow = {
	name: string;
	secret_name: string;
	consumer: string;
	testable: boolean;
	set: boolean;
	modified: string | null;
};

/**
 * The registry merged with the store's metadata list. Status and last-updated
 * come straight from the store (Read-visible metadata only — never a value,
 * because no value can ever come back).
 */
export async function listKeys(env: Env, supabase: SupabaseClient): Promise<
	{ ok: true; keys: KeyStatusRow[] } | { ok: false; error: string }
> {
	const cfg = await resolveStoreConfig(env, supabase);
	if ("missing" in cfg) return { ok: false, error: `The keys circuit is missing ${cfg.missing}.` };
	const listed = await storeFetch<StoreSecretRow[]>(cfg, "/secrets?per_page=100");
	if (!listed.ok) return listed;
	const stored = new Map(listed.result.map((s) => [s.name, s]));
	return {
		ok: true,
		keys: KEY_REGISTRY.map((entry) => {
			const row = stored.get(entry.secretName);
			return {
				name: entry.name,
				secret_name: entry.secretName,
				consumer: entry.consumer,
				testable: entry.testable,
				set: row !== undefined,
				modified: row?.modified ?? row?.created ?? null,
			};
		}),
	};
}

/**
 * Save a new value for a registry key: PATCH by ID when the secret exists,
 * POST (create, scopes ["workers"]) when it doesn't. Registry names only —
 * an unknown name is refused, not created (the fixed-registry rule).
 */
export async function saveKey(
	env: Env,
	supabase: SupabaseClient,
	name: string,
	value: unknown,
): Promise<{ ok: true; created: boolean } | { ok: false; error: string }> {
	const entry = byName.get(name);
	if (!entry) return { ok: false, error: `${name} is not a managed key.` };
	if (typeof value !== "string" || value.trim().length === 0) {
		return { ok: false, error: "A new value is required." };
	}
	// Trailing newline from a paste is the classic silent key-breaker.
	const clean = value.trim();
	if (clean.length > MAX_VALUE_LENGTH) {
		return { ok: false, error: "That value is implausibly long for a key." };
	}

	const cfg = await resolveStoreConfig(env, supabase);
	if ("missing" in cfg) return { ok: false, error: `The keys circuit is missing ${cfg.missing}.` };

	// Name → ID: the update endpoint addresses secrets by ID only.
	const listed = await storeFetch<StoreSecretRow[]>(cfg, "/secrets?per_page=100");
	if (!listed.ok) return listed;
	const existing = listed.result.find((s) => s.name === entry.secretName);

	if (existing) {
		const patched = await storeFetch<StoreSecretRow>(cfg, `/secrets/${existing.id}`, {
			method: "PATCH",
			body: JSON.stringify({ value: clean }),
		});
		if (!patched.ok) return patched;
		return { ok: true, created: false };
	}

	const created = await storeFetch<StoreSecretRow[]>(cfg, "/secrets", {
		method: "POST",
		// The body is an array by API shape; scopes must include "workers" or a
		// later binding deploy is rejected outright.
		body: JSON.stringify([{ name: entry.secretName, value: clean, scopes: ["workers"] }]),
	});
	if (!created.ok) return created;
	return { ok: true, created: true };
}

/**
 * The wizard's bootstrap (Haven fork): a virgin install knows only the
 * CF_SECRETS_STORE_TOKEN captured at button-deploy time. This discovers the
 * account id and the store id through the API with that token and persists
 * them as preferences rows so the keys circuit can write from then on. Ours
 * never runs it (env vars/seeded rows resolve first). Fail loud with the
 * exact fix — the setup guide tells Steff which token scopes make this work
 * ("Account Settings: Read" + "Account Secrets Store: Edit").
 */
export async function ensureStoreCoordinates(
	env: Env,
	supabase: SupabaseClient,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const already = await resolveStoreConfig(env, supabase);
	if (!("missing" in already)) return { ok: true };
	if (!env.CF_SECRETS_STORE_TOKEN) {
		return {
			ok: false,
			error:
				"CF_SECRETS_STORE_TOKEN is not set — it should have been captured when the Deploy button ran.",
		};
	}
	const authed = { Authorization: `Bearer ${env.CF_SECRETS_STORE_TOKEN}` };

	// Account id: env → row → GET /accounts with the token.
	let accountId = env.CF_ACCOUNT_ID || "";
	if (!accountId) {
		const res = await fetchWithTimeout(`${API_BASE}/accounts`, { headers: authed }, { service: "cloudflare" });
		const body = (await res.json().catch(() => null)) as CfEnvelope<Array<{ id: string }>> | null;
		const first = body?.result?.[0];
		if (!res.ok || body?.success === false || !first?.id) {
			return {
				ok: false,
				error:
					"Couldn't discover the Cloudflare account id with the Secrets Store token — the token needs the 'Account Settings: Read' scope (see the setup guide).",
			};
		}
		accountId = first.id;
	}

	// Store id: list the account's stores; create one only if none exists.
	let storeId = env.CF_STORE_ID || "";
	if (!storeId) {
		const listRes = await fetchWithTimeout(
			`${API_BASE}/accounts/${accountId}/secrets_store/stores?per_page=100`,
			{ headers: authed },
			{ service: "cloudflare" },
		);
		const listBody = (await listRes.json().catch(() => null)) as
			| CfEnvelope<Array<{ id: string; name?: string }>>
			| null;
		if (!listRes.ok || listBody?.success === false) {
			const detail = listBody?.errors?.map((e) => e.message).filter(Boolean).join("; ");
			return { ok: false, error: `Couldn't list Secrets Store stores: ${detail || listRes.status}.` };
		}
		const stores = listBody?.result ?? [];
		const preferred =
			stores.find((s) => s.name === "default_secrets_store") ?? stores[0];
		if (preferred) {
			storeId = preferred.id;
		} else {
			const createRes = await fetchWithTimeout(
				`${API_BASE}/accounts/${accountId}/secrets_store/stores`,
				{
					method: "POST",
					headers: { ...authed, "Content-Type": "application/json" },
					body: JSON.stringify({ name: "default_secrets_store" }),
				},
				{ service: "cloudflare" },
			);
			const createBody = (await createRes.json().catch(() => null)) as
				| CfEnvelope<{ id: string }>
				| null;
			if (!createRes.ok || createBody?.success === false || !createBody?.result?.id) {
				const detail = createBody?.errors?.map((e) => e.message).filter(Boolean).join("; ");
				return { ok: false, error: `Couldn't create a Secrets Store store: ${detail || createRes.status}.` };
			}
			storeId = createBody.result.id;
		}
	}

	const { error } = await supabase.from("preferences").upsert(
		[
			{ key: "cf.account_id", value: accountId },
			{ key: "cf.store_id", value: storeId },
		],
		{ onConflict: "key" },
	);
	if (error) return { ok: false, error: `Couldn't save the store coordinates: ${error.message}` };
	return { ok: true };
}

/**
 * The per-key test — cheap and safe only, never a billable call. Since the
 * cutover these resolve through secrets.ts, i.e. they test THE value the
 * Worker actually runs on: the store-backed binding. A key missing from the
 * store fails here with the same loud message every consumer would raise.
 */
export async function testKey(env: Env, name: string): Promise<{ ok: boolean; detail: string }> {
	const entry = byName.get(name);
	if (!entry) return { ok: false, detail: `${name} is not a managed key.` };

	const probe = async (
		url: string,
		headers: Record<string, string>,
		label: string,
	): Promise<{ ok: boolean; detail: string }> => {
		try {
			const res = await fetchWithTimeout(url, { headers }, { service: "keytest" });
			if (res.ok) return { ok: true, detail: `${label} accepted the key.` };
			return { ok: false, detail: `${label} answered ${res.status} — the key looks wrong or revoked.` };
		} catch (e) {
			return { ok: false, detail: `${label} unreachable: ${e instanceof Error ? e.message : String(e)}` };
		}
	};

	try {
		switch (name) {
			case "ANTHROPIC_API_KEY":
				return await probe(
					"https://api.anthropic.com/v1/models",
					{ "x-api-key": await getSecret(env, name), "anthropic-version": "2023-06-01" },
					"Anthropic",
				);
			case "ELEVENLABS_API_KEY":
				return await probe(
					"https://api.elevenlabs.io/v1/voices",
					{ "xi-api-key": await getSecret(env, name) },
					"ElevenLabs",
				);
			case "GETIMG_API_KEY":
				// Models list: free, and on the same v2 API the Gallery generates
				// against (v1 paths 401 even for a good key — caught live, 18 Jul).
				// NEVER a generation.
				return await probe(
					"https://api.getimg.ai/v2/models",
					{ Authorization: `Bearer ${await getSecret(env, name)}` },
					"getimg",
				);
			case "HA_MCP_URL":
			case "HA_TOKEN":
				// One test covers the pair: a real MCP initialize against the endpoint
				// with the token — the only honest way to test either.
				return await pingMcp(await haServer(env));
			case "NOTION_TOKEN":
				return await probe(
					"https://api.notion.com/v1/users/me",
					{ Authorization: `Bearer ${await getSecret(env, name)}`, "Notion-Version": env.NOTION_VERSION },
					"Notion",
				);
			case "OPENROUTER_API_KEY":
				// /key returns the key's own metadata — auth-gated (the models list
				// is public and would pass any string), free, never an embedding.
				return await probe(
					"https://openrouter.ai/api/v1/key",
					{ Authorization: `Bearer ${await getSecret(env, name)}` },
					"OpenRouter",
				);
			default:
				return { ok: false, detail: `No test wired for ${name}.` };
		}
	} catch (e) {
		// getSecret failing IS the verdict: the store has no value for this key.
		return { ok: false, detail: e instanceof Error ? e.message : String(e) };
	}
}
