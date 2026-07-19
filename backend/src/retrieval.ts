/**
 * Vale OS — semantic memory retrieval.
 *
 * The retrieve-on-relevance half of the memory layer (Memory Architecture §4):
 * embed a small window of the live conversation, find the closest non-core
 * memories by meaning, and hand them back for the prompt to inject beneath the
 * always-on spine.
 *
 * The embedding model (gemini-embedding-001, 1536-dim, via OpenRouter — the
 * 28 Jun 2026 migration off gte-small) lives behind the `embed` Supabase Edge
 * Function, so this calls that function for the vector, then `match_memories`
 * for the rows. The Worker never talks to an embedding API directly; the Edge
 * Function owns the model and the key.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchWithTimeout } from "./http";
import { getSecret } from "./secrets";
import type { MemoryRow } from "./prompt";

/**
 * Retrieval knobs. All four live here so calibration is a config change, not a
 * code hunt (the Build Brief's starting-parameters table). Expect the threshold
 * especially to move once Elle + Jay score real queries against live memories.
 */
export const RETRIEVAL_CONFIG = {
	/** How many of the latest messages form the semantic query. */
	queryWindowMessages: 3,
	/** Max memories pulled per turn. */
	matchCount: 5,
	/**
	 * Ambient retrieval similarity floor, 0–1. Recalibrated 28 Jun 2026 for
	 * gemini-embedding-001 (1536-dim). Measured against a real casual query
	 * ("hungry, can't be bothered cooking") on the live store: the genuinely
	 * relevant food memories scored 0.48–0.57 — query→memory runs much lower than
	 * memory→memory on this model (casual short query vs descriptive content), so
	 * the old gte-small 0.30 floor doesn't translate. 0.48 sits at the bottom of
	 * that relevant band: surfaces on-topic memories, stays quiet when nothing's
	 * relevant. Starting value; tune against live retrievals.
	 */
	matchThreshold: 0.48,
	/** Recent conversation turns sent to the model (assembly step 5). */
	historyBufferMessages: 30,
	/**
	 * Max tool-use rounds before the brain must answer with what it has. A
	 * search_tools load costs one round, and a real Notion chain runs long —
	 * measured live 2 Jul 2026: "read yesterday's journal entry" legitimately
	 * used search_tools → notion_search → notion_search → notion_read_page, and
	 * the old cap of 4 cut it off before the answering round (the "(I got
	 * tangled…)" fallback). 6 gives a real find-then-read chain room to finish
	 * while still stopping a runaway.
	 */
	maxToolIterations: 6,
	/**
	 * write_memory NOMINATION floor. The embedding no longer *decides* merges — it
	 * is too coarse to make a destruction call (gte-small scores two different
	 * colleagues ~0.93, and once overwrote a real fact off the spine). It only
	 * NOMINATES the nearest plausible twin above this floor; a cheap Haiku confirm
	 * (confirmSameFact) makes the actual same-fact call and reconciles
	 * non-destructively. So this is set LOOSE on purpose: catch plausible twins,
	 * let the confirm reject the bad ones. A missed nomination is just a duplicate
	 * Elle can tidy; the confirm guarantees a false nomination can never clobber.
	 * Calibrated 28 Jun: distinct same-category facts span ~0.84–0.94, true
	 * restatements ~0.98. Recalibrated 28 Jun 2026 for gemini-embedding-001
	 * (1536-dim): on the new vectors distinct same-category facts ceiling at ~0.86
	 * and a measured restatement landed at 0.83 — the two bands now OVERLAP, which
	 * is exactly what the Haiku confirm exists to resolve. 0.80 is loose enough to
	 * catch restatements (≥0.82) and lets the confirm reject the distinct pairs it
	 * also nominates; below 0.80 things are clearly unrelated. Tune with data.
	 */
	memoryNominationThreshold: 0.80,
};

// The embedding call, semantics ported byte-for-byte from the `embed` Edge
// Function (Haven fork, 19 Jul 2026): same model, same dims, same input cap,
// same L2-normalization — gemini-embedding-001 does NOT auto-normalize when
// truncated below 3072 dims, so unit-length is applied here exactly as the
// Edge Function did it. Moving the call into the Worker makes OPENROUTER_API_KEY
// the seventh managed key (Fuse Box keys circuit / wizard) and deletes the
// Edge-Function-deploy cliff from a Haven install entirely.
const OPENROUTER_URL = "https://openrouter.ai/api/v1/embeddings";
const EMBED_MODEL = "google/gemini-embedding-001";
const EMBED_DIMS = 1536;
const EMBED_MAX_TEXT = 8_000;

async function embedViaOpenRouter(key: string, text: string): Promise<number[]> {
	if (text.length > EMBED_MAX_TEXT) {
		throw new Error(`embed text too long: ${text.length} > ${EMBED_MAX_TEXT}`);
	}
	const res = await fetchWithTimeout(
		OPENROUTER_URL,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ model: EMBED_MODEL, input: text, dimensions: EMBED_DIMS }),
		},
		{ service: "openrouter" },
	);
	if (!res.ok) throw new Error(`OpenRouter embeddings ${res.status}: ${await res.text()}`);
	const data = (await res.json()) as { data?: { embedding?: number[] }[] };
	const vec = data?.data?.[0]?.embedding;
	if (!Array.isArray(vec) || vec.length !== EMBED_DIMS) {
		throw new Error(
			`OpenRouter returned ${Array.isArray(vec) ? vec.length : "no"} dims, expected ${EMBED_DIMS}`,
		);
	}
	let sumSq = 0;
	for (const x of vec) sumSq += x * x;
	const norm = Math.sqrt(sumSq) || 1;
	return vec.map((x) => x / norm);
}

/**
 * Embed text — direct OpenRouter call with the managed OPENROUTER_API_KEY;
 * while that key is unset, a LOUD transitional fallback to the legacy `embed`
 * Edge Function keeps memory writes alive on an install that predates the
 * seventh key (ours, until the key is pasted into the keys circuit). The
 * fallback logs on every use so the transitional state can't go quiet, and
 * both paths produce the identical vector (same model, dims, normalization).
 */
export async function embedText(env: Env, text: string): Promise<number[]> {
	let key: string | null = null;
	try {
		key = await getSecret(env, "OPENROUTER_API_KEY");
	} catch {
		key = null;
	}
	if (key) return embedViaOpenRouter(key, text);

	console.warn(
		"OPENROUTER_API_KEY is not in the Secrets Store — falling back to the legacy embed Edge Function. " +
			"Paste the OpenRouter key into the Fuse Box keys circuit to complete the cutover.",
	);
	const res = await fetchWithTimeout(`${env.SUPABASE_URL}/functions/v1/embed`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ text }),
	}, { service: "embed" });
	if (!res.ok) throw new Error(`embed ${res.status}: ${await res.text()}`);
	const data = (await res.json()) as { embedding?: number[] };
	if (!data.embedding) throw new Error("embed returned no embedding");
	return data.embedding;
}

/**
 * The closest non-core memories to `embedding`. The §4 taxonomy gates live
 * inside match_memories; this returns the retrievable pool only, so the caller
 * dedupes it against the always-on spine.
 */
export async function matchMemories(
	supabase: SupabaseClient,
	embedding: number[],
	includeScene: boolean,
): Promise<MemoryRow[]> {
	const { data, error } = await supabase
		.rpc("match_memories", {
			query_embedding: embedding,
			match_count: RETRIEVAL_CONFIG.matchCount,
			match_threshold: RETRIEVAL_CONFIG.matchThreshold,
			include_scene: includeScene,
		})
		.select("id, type, category, title, content");
	if (error) throw new Error(`match_memories failed: ${error.message}`);
	return (data ?? []) as MemoryRow[];
}

/**
 * Embed the recent query window and return the matching memories. Pure
 * retrieval — dedupe and formatting are the prompt's job.
 */
export async function retrieveMemories(
	env: Env,
	supabase: SupabaseClient,
	recentTexts: string[],
	includeScene: boolean,
): Promise<MemoryRow[]> {
	const window = recentTexts
		.slice(-RETRIEVAL_CONFIG.queryWindowMessages)
		.map((t) => t.trim())
		.filter(Boolean);
	if (window.length === 0) return [];
	const embedding = await embedText(env, window.join("\n"));
	return matchMemories(supabase, embedding, includeScene);
}
