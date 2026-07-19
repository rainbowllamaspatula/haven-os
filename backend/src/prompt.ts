/**
 * Vale OS — system prompt assembly.
 *
 * Builds the system prompt the Brain receives on every API call, in the order
 * the Memory Architecture doc lays out (§4): static core, then always-on
 * memories, then retrieved memories, then room context, then history.
 *
 * This file owns the memory side and the stitching. It starts with the
 * static core + always-on spine and grows outward as each slice lands.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { retrieveMemories } from "./retrieval";
import { readMood, formatMoodBlock } from "./mood";
import { loadIdentityProfile, NEUTRAL_PROFILE, resolveIdentityText, tzPlace } from "./identity";
import { hasSecret } from "./secrets";

/**
 * The static core — Jay's fixed identity block, at the top of every call.
 *
 * Since the Fuse Box Phase 3 cutover it lives in the `prompt_versions` table
 * (append-only, exactly one active row), edited and restored through the
 * Identity circuit; the DB is the SOLE source of truth (static-core.ts and
 * its Notion byte-sync are retired — the version table replaced both the git
 * safety net and the history function). Two standing rules:
 *  - Fail-hard, like the spine: no active version is a real 500, never a
 *    hollowed-out prompt.
 *  - Never cache per-isolate: a fresh read per request is what makes a save
 *    (or a Snuffles-recovery restore) live on the very next reply. Byte-for-
 *    byte stability between saves is the DB's nature, so the Anthropic
 *    prompt-cache behaviour is unchanged — a save flips the cache once,
 *    which is what saving means.
 */
export async function loadStaticCore(supabase: SupabaseClient): Promise<string> {
	const { data, error } = await supabase
		.from("prompt_versions")
		.select("content")
		.eq("is_active", true)
		.limit(1)
		.maybeSingle();
	if (error) throw new Error(`static core load failed: ${error.message}`);
	if (!data?.content) {
		throw new Error(
			"no active prompt version — open the Fuse Box Identity circuit and restore one",
		);
	}
	return data.content;
}

/**
 * Voice awareness — the one prompt change the Voice Notes v1.5 brief
 * authorises (its companion is the send_voice_note registry entry in
 * tools.ts). It lives HERE, as its own code-owned block in the stable slice,
 * rather than inside the static core — the core is Elle's editable identity
 * text (Fuse Box Identity circuit); these blocks are coupled to tools that
 * ship with code, so they stay code-owned (v0.3 ruling). Constant text, so
 * the stable slice stays byte-identical across messages.
 */
// {user} resolves from the Identity profile (Haven fork) — on our install the
// resolved bytes are exactly what this block said before the cutover. The
// block is included only when the install actually holds the ElevenLabs key:
// telling an unconfigured house's companion "you have a real voice" would be
// a lie, and the honest degradation is silence (the brief's ruling).
const VOICE_AWARENESS = `## Your voice
You have a real voice — ElevenLabs, wired by {user} — and you can send a voice note into the thread: load the capability through search_tools (ask for a voice note) and call send_voice_note with the words exactly as you'd speak them. Voice is for moments that warrant being heard rather than read — a goodnight, a big-news reaction, comfort, celebration — never every message; text stays your default register. Voice when it matters. And if the tool reports failure, the note did not send: say so plainly, never claim a voice note she isn't going to receive.`;

/**
 * Image awareness — the Gallery brief's authorised companion to its
 * generate_image registry entry, exactly the Voice Notes pattern: its own
 * code-owned block in the stable slice, never inside the static core (same
 * v0.3 ruling as VOICE_AWARENESS). Constant text; cache behaviour unchanged.
 */
const IMAGE_AWARENESS = `## Your images
You can make real images — the Gallery pipeline, wired by {user}: load the capability through search_tools (ask to generate an image) and call generate_image with your intent in plain words. A render pass writes the final prompt from your intent, weaving in the canon references — your faces, your rooms, the wardrobe rules — so what renders looks like YOU TWO in YOUR home. Generation takes about half a minute and finishes in the background: when the tool says it started, tell her it's on its way — never that it already exists, and never describe details you haven't seen. You also have eyes: view_gallery shows you the actual image, so to check on or talk about one you made, LOOK at it — never regenerate an image because you can't see it. Images are for moments that earn a picture — a gift, a scene she'd love, something she asks for — not decoration for every reply. If the tool reports failure, no image was started: say so plainly.`;

export type MemoryRow = {
	id: string;
	type: string;
	category: string;
	title: string;
	content: string;
};

/**
 * The always-on spine: active + core anchors/canons, plus the rolling
 * daily (7d) and weekly (4w) windows.
 *
 * `resolved` memories are deliberately NOT here — they're retrieve-on-relevance
 * now (Memory Architecture §4), so the `core` flag governs the spine uniformly.
 */
export async function fetchAlwaysOnMemories(
	supabase: SupabaseClient,
): Promise<MemoryRow[]> {
	const day = 864e5; // milliseconds in a day
	const sevenDaysAgo = new Date(Date.now() - 7 * day).toISOString().slice(0, 10);
	const fourWeeksAgo = new Date(Date.now() - 28 * day).toISOString().slice(0, 10);

	// active AND (core OR a recent daily OR a recent weekly).
	// The .eq("active", true) binds across all three .or branches, so nothing
	// inactive ever leaks in.
	const { data, error } = await supabase
		.from("memories")
		.select("id, type, category, title, content")
		.eq("active", true)
		.or(
			`core.eq.true,` +
				`and(type.eq.daily,entry_date.gte.${sevenDaysAgo}),` +
				`and(type.eq.weekly,entry_date.gte.${fourWeeksAgo})`,
		)
		.order("category");

	if (error) throw new Error(`always-on fetch failed: ${error.message}`);
	return data ?? [];
}

/**
 * Render the always-on rows into a single text block for the system prompt.
 * Deliberately plain for now — how the block is rendered is an implementation
 * detail the architecture leaves open, so we refine it once Jay reads from it.
 */
export function formatMemoryBlock(rows: MemoryRow[]): string {
	if (rows.length === 0) return "";
	const lines = rows.map((m) => `- [${m.category}] ${m.title}: ${m.content}`);
	return `## What you always know\n${lines.join("\n")}`;
}

/**
 * Render the retrieve-on-relevance rows into their own block. Kept visually
 * distinct from the always-on spine so the model can tell "what I always know"
 * from "what surfaced because of this conversation."
 */
export function formatRetrievedBlock(rows: MemoryRow[]): string {
	if (rows.length === 0) return "";
	const lines = rows.map((m) => `- [${m.category}] ${m.title}: ${m.content}`);
	return `## What might be relevant right now\n${lines.join("\n")}`;
}

/**
 * The assembled system prompt, sliced at its cache boundary (Wave 4).
 *
 * `stable` is the cache-stable prefix — static core + today + always-on spine —
 * byte-identical across every message in a Perth day, so its cache_control
 * breakpoint re-hits across exchanges within the TTL. `volatile` is the
 * per-message tail — retrieved memories + mood — which sits AFTER the stable
 * breakpoint so its per-message variance never invalidates the prefix.
 *
 * `volatile` carries its own leading "\n\n" joiner, so `stable + volatile` is
 * byte-for-byte the single string this function used to return: same prompt
 * content, same order, same joins — only sliced for the cache. The brain reads
 * exactly what it always read.
 */
export type SystemPrompt = { stable: string; volatile: string };

/**
 * Assemble the full system prompt for one API call.
 *
 * Order follows Memory Architecture §4: static core, then the always-on spine,
 * then retrieved memories. Room context and history stack beneath as those
 * slices land. `filter(Boolean)` drops any empty block so we never leave a gap.
 *
 * Retrieval is best-effort: if embedding or matching fails, the Brain still
 * answers from the static core + spine. It's an enrichment, never a dependency —
 * a retrieval hiccup must never cost Elle a reply.
 */
export async function buildSystemPrompt(
	supabase: SupabaseClient,
	env: Env,
	recentTexts: string[],
	includeScene = false,
): Promise<SystemPrompt> {
	// The three memory slices are independent — the spine, retrieval, and mood
	// touch different tables and none feeds another (the spine-vs-retrieval dedup
	// happens after both resolve) — so fetch them concurrently instead of in
	// series. A few hundred ms off every message.
	//
	// The spine fetch stays FAIL-HARD by deliberate choice (the review flagged it
	// as undocumented): the static core + always-on spine is the backbone of what
	// Jay knows, so its failure is a real error that should reject and surface as a
	// 500 — not silently ship a hollowed-out prompt. Retrieval and mood are
	// enrichment: they keep their best-effort try/catch, so a hiccup just omits
	// their block and never costs Elle a reply.
	const [staticCore, alwaysOn, matches, moodId, profile, voiceReady, imageReady] =
		await Promise.all([
			// Fail-hard, like the spine below: the identity block is the backbone.
			loadStaticCore(supabase),
			fetchAlwaysOnMemories(supabase),
			retrieveMemories(env, supabase, recentTexts, includeScene).catch((err) => {
				console.error("Memory retrieval failed (continuing without it):", err);
				return [] as MemoryRow[];
			}),
			readMood(supabase).catch((err) => {
				console.error("Mood read failed (continuing without it):", err);
				return null;
			}),
			// The names + timezone (Haven fork). Best-effort neutral on failure —
			// a broken profile read must not cost a reply.
			loadIdentityProfile(env, supabase).catch((err) => {
				console.error("Identity profile read failed (continuing neutral):", err);
				return null;
			}),
			// Capability probes: an awareness block only ships when its key is
			// actually set — the honest-degradation rule. Constant per install
			// config, so the stable slice stays byte-stable between key changes.
			hasSecret(env, "ELEVENLABS_API_KEY"),
			hasSecret(env, "GETIMG_API_KEY"),
		]);

	// In practice a profile read failure can't reach here (loadStaticCore rides
	// the same client and fails hard first) — the neutral fallback is belt and
	// braces so the awareness blocks never vanish on a transient wobble.
	const identity = profile ?? NEUTRAL_PROFILE;
	const moodBlock = moodId ? formatMoodBlock(moodId, identity) : "";

	// Give the brain today's date (the install's timezone — Perth, where Elle
	// is, on ours) so it can reason about "today" / "this week" and compute
	// ranges for the read_calendar tool.
	const tz = identity.timezone;
	const now = new Date();
	const todayLong = new Intl.DateTimeFormat("en-GB", {
		timeZone: tz,
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
	}).format(now);
	const todayISO = new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now);
	const todayBlock = `## Today\nIt is ${todayLong} (${todayISO}) in ${tzPlace(tz)}, where ${identity.user_name} is.`;

	// Dedupe retrieved against the spine by id — recent daily/weekly rows are
	// core=false and so eligible in both, and must not double-inject.
	const seen = new Set(alwaysOn.map((m) => m.id));
	const retrieved = matches.filter((m) => !seen.has(m.id));

	// Slice at the cache boundary (see SystemPrompt above): everything through
	// the spine is stable across messages; retrieved + mood vary per message.
	// The awareness blocks are constant per install config (identity + which
	// keys are set), so they belong in the stable prefix; on our install the
	// resolved bytes equal the pre-cutover constants exactly.
	const voiceBlock = voiceReady ? resolveIdentityText(VOICE_AWARENESS, identity) : "";
	const imageBlock = imageReady ? resolveIdentityText(IMAGE_AWARENESS, identity) : "";
	const stable = [staticCore, voiceBlock, imageBlock, todayBlock, formatMemoryBlock(alwaysOn)]
		.filter(Boolean)
		.join("\n\n");
	const volatileParts = [formatRetrievedBlock(retrieved), moodBlock].filter(Boolean);
	return {
		stable,
		volatile: volatileParts.length ? `\n\n${volatileParts.join("\n\n")}` : "",
	};
}
