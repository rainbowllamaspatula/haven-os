/**
 * Vale OS — backend Worker
 *
 * The single origin behind the house. It runs first for every request
 * (run_worker_first = true in wrangler.jsonc), so it can check the password gate
 * before serving anything:
 *
 *   - not logged in  → the login page (or 401 for /api/*)
 *   - POST /api/login → check password, set the session cookie
 *   - logged in, /api/* → the API (message / history / rooms)
 *   - logged in, anything else → the built PWA, served from static assets
 *
 * The gate is enforced in production only; the local sandbox stays open. Because
 * it lives here, it guards the custom domain and the workers.dev URL with one lock.
 *
 * Secrets (never written here): SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY,
 * and VALE_PASSWORD. Regenerate the Env type with `npx wrangler types` after
 * changing bindings or adding a secret.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fetchWithTimeout } from "./http";
import { buildSystemPrompt, type SystemPrompt } from "./prompt";
import { RETRIEVAL_CONFIG } from "./retrieval";
import {
	runTool,
	searchTools,
	shortlistMessage,
	noMatchMessage,
	residentDefinitions,
	buildToolContext,
	resolveDefinitions,
	type ToolDefinition,
	type ToolExtras,
} from "./tools";
import {
	startGeneration,
	retryGeneration,
	deleteImage,
	loadActiveReferences,
	sweepDeadGenerations,
	DEFAULT_MODEL_ID,
	MODEL_CATALOG,
} from "./gallery";
import { handleMcp, handleOAuth } from "./mcp-server";
import {
	getOrCreateActiveConversation,
	loadActiveConversationMessages,
	loadRecentMessages,
	saveMessage,
	touchConversation,
	getMessageForVoice,
	setMessageMetadata,
} from "./persistence";
import { renderVoiceNote, voiceMetadata, audioKey, loadVoiceIdentity } from "./voice";
import { sessionStatus, sessionCookie, loginPage } from "./auth";
import { checkHousePassword, setupRequired, handleSetupRequest } from "./setup";
import { fuseboxStatus, fuseboxCookie, FUSEBOX_TTL_MS } from "./fusebox";
import {
	COLOR_SLOTS,
	FONT_SLOTS,
	FONT_KEYS,
	FONT_STACKS,
	validateDecorTokens,
	sanitizeDecorTokens,
	resolveDecor,
	decorCss,
	loadActiveDecor,
	injectDecor,
	parseDecorImport,
} from "./decor";
import { listKeys, saveKey, testKey } from "./fusebox-keys";
import {
	listMemories,
	spineStats,
	createMemory,
	updateMemory,
	deleteMemory,
	importMemories,
} from "./fusebox-memories";
import {
	listReferences,
	upsertReference,
	updateReference,
	deleteReference,
} from "./fusebox-references";
import {
	validateHearthRegistry,
	validateWorkshopMappings,
	validateWorkshopBlocks,
	validateVacuumRoster,
	validateAudioRoster,
	loadHearthRegistry,
	loadVacuumRoster,
	loadAudioRoster,
	loadWorkshopBlocks,
} from "./config";
import { getSecret, hasSecret } from "./secrets";
import { loadIdentityProfile, validateIdentityProfile, resolveIdentityText } from "./identity";
import { readMood, writeMood, isValidMood } from "./mood";
import { getProjects } from "./projects";
import { getBlockTiles, getDataSourceSchema } from "./workshop-blocks";
import { getRecent, searchNotion } from "./notion";
import {
	getViews,
	getMessages,
	getMessage,
	modifyLabels,
	markRead,
	setStar,
	archiveMessage,
	trashMessage,
	sendMail,
	saveDraft,
	updateDraft,
	deleteDraft,
	getDrafts,
	createTask,
	suggestTaskTitle,
	inboxGlance,
	type Compose,
	type TaskInput,
} from "./postbox";
import { getWeather } from "./weather";
import {
	getNowPlayingCached,
	bustNowPlayingCache,
	getRecentlyPlayed,
	getPlaylists,
	searchBrowse,
	play,
	pause,
	nextTrack,
	previousTrack,
	setShuffle,
	setRepeat,
	setPlayerVolume,
	seekTo,
} from "./spotify";
import {
	getHomeCached,
	setLight,
	lightOnOff,
	setScene,
	allLightsOff,
	goodnight,
	vacuumAction,
	mediaAction,
	validateArea,
} from "./home";

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

// A message in the shape the front-end stores it.
type ClientMessage = { from: "elle" | "jay"; text: string };

// DEV ONLY. Production owns the thread in Supabase (see /api/message). The local
// sandbox keeps persistence off, so this module-scope array stands in as the
// thread — `wrangler dev` is a single isolate, so it survives between turns and
// gives local chat short-term context. Never read or written in production.
const devThread: ClientMessage[] = [];

// Map the front-end's history to what the Anthropic API expects. Keep only the
// most recent `limit` turns (the conversation-history buffer, assembly step 5),
// then make sure the window opens on a user turn — the API requires the first
// message to be `user`, so any leading assistant lines (like a restored
// greeting) get dropped.
export function toAnthropicMessages(history: ClientMessage[], limit: number) {
	const mapped = history.map((m) => ({
		role: m.from === "elle" ? ("user" as const) : ("assistant" as const),
		content: m.text,
	}));
	const windowed = mapped.slice(-limit);
	while (windowed.length && windowed[0].role === "assistant") windowed.shift();
	return windowed;
}

// A content block in an Anthropic message (text, tool_use, or tool_result).
type Block = { type: string; [k: string]: unknown };
// A message in the running conversation — content is a plain string (the
// front-end turns) or an array of blocks (tool_use / tool_result turns).
type BrainMessage = { role: "user" | "assistant"; content: string | Block[] };

// The token usage Anthropic reports per call. All optional — defend against a
// field being absent rather than assuming the shape.
type Usage = {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
};

// Usage summed across every API call in one exchange (the tool loop can make
// several), plus how many calls it took and which model answered. Stored model
// is deliberate: cost history must survive a future model switch.
type CostSummary = {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens: number;
	cache_read_input_tokens: number;
	api_calls: number;
	model: string;
};

// A live-reply event runBrain emits as it streams: a text delta as it arrives,
// or a status marker when a tool round begins (the client turns "…" into
// "(looking that up…)"). Transport only — none of this changes what Jay says.
type BrainEvent = { type: "delta"; text: string } | { type: "status"; label: string };

// One call to the Anthropic Messages API, with the caller's currently-active
// tools attached — runBrain seeds these with the resident set and grows them as
// search_tools loads more. Throws on a non-OK response so the caller can
// surface an error; tool *execution* failures are handled separately (they
// return is_error results).
//
// Streams (stream: true): text deltas are forwarded to `onText` as they arrive,
// while the full block set is accumulated so the tool loop reads tool_use exactly
// as it did when this was a blocking `await res.json()`. Return shape is unchanged.
//
// Prompt caching (breakpoints deepest-last, max 4): one on the LAST tool
// definition, one on the stable system block (static core + today + spine —
// byte-identical across messages, so follow-up exchanges within the 5-minute TTL
// re-read it), one on the volatile system block (retrieved + mood — changes per
// message, so it lives AFTER the stable breakpoint and its variance can't
// invalidate the prefix), and one on the final block of the final message so each
// tool-loop round re-reads the whole conversation prefix the previous round paid
// for. Caching and streaming change transport and price, never one word of the
// reply. Proof is already wired — the cost tally surfaces cache_read_input_tokens.
//
// Known wrinkle, accepted (and measured worse than the brief assumed): tools
// render at position 0, so when search_tools grows activeTools mid-exchange the
// WHOLE prefix — tools, system, conversation — misses for that round, not just the
// tools block. Rounds after it re-hit on the settled toolset. Bounded cost; noted,
// not engineered around.
async function callAnthropic(
	env: Env,
	system: SystemPrompt,
	messages: BrainMessage[],
	activeTools: ToolDefinition[],
	onText?: (delta: string) => void,
): Promise<{ content: Block[]; stop_reason: string; usage?: Usage; model?: string }> {
	// Observability for the dynamic-tools loop (visible via `wrangler tail`):
	// the exact outgoing tool set, per call. A plain message shows only the
	// residents; a loaded tool shows up here on the call after its search.
	console.log(`brain call: tools = [${activeTools.map((t) => t.name).join(", ")}]`);
	const cacheControl = { type: "ephemeral" as const };
	const systemBlocks = [
		{ type: "text", text: system.stable, cache_control: cacheControl },
		// The volatile tail carries its own leading joiner, so stable + volatile is
		// byte-identical to the pre-split single system string. Skipped when empty.
		...(system.volatile
			? [{ type: "text", text: system.volatile, cache_control: cacheControl }]
			: []),
	];
	const tools: Array<ToolDefinition & { cache_control?: typeof cacheControl }> = activeTools.map(
		(t, i) => (i === activeTools.length - 1 ? { ...t, cache_control: cacheControl } : t),
	);
	// The conversation-prefix breakpoint: mark the final block of the final
	// message (serialisation only — the caller's convo is never mutated).
	const wireMessages = messages.map((m, i) => {
		if (i !== messages.length - 1) return m;
		if (typeof m.content === "string") {
			return {
				role: m.role,
				content: [{ type: "text", text: m.content, cache_control: cacheControl }],
			};
		}
		return {
			role: m.role,
			content: m.content.map((b, j) =>
				j === m.content.length - 1 ? { ...b, cache_control: cacheControl } : b,
			),
		};
	});
	const anthropicKey = await getSecret(env, "ANTHROPIC_API_KEY");
	const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"x-api-key": anthropicKey,
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: "claude-sonnet-4-6",
			max_tokens: 2048,
			system: systemBlocks,
			messages: wireMessages,
			tools,
			stream: true,
		}),
	}, { service: "anthropic" });
	if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
	return readAnthropicStream(res, onText);
}

// Consume the Messages API SSE stream into the same {content, stop_reason, usage,
// model} shape the blocking path returned. Text deltas go to onText as they land;
// tool_use blocks accumulate their partial_json and parse on content_block_stop.
// usage is stitched from message_start (input + cache tokens) and message_delta
// (output tokens) so the cost tally is identical to the non-streamed reply.
async function readAnthropicStream(
	res: Response,
	onText?: (delta: string) => void,
): Promise<{ content: Block[]; stop_reason: string; usage?: Usage; model?: string }> {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const blocks: Block[] = [];
	const jsonParts: string[] = []; // per-index partial_json for tool_use blocks
	let stop_reason = "";
	let model: string | undefined;
	const usage: Usage = {};

	const handle = (ev: Record<string, unknown>) => {
		switch (ev.type) {
			case "message_start": {
				const msg = ev.message as { model?: string; usage?: Usage } | undefined;
				model = msg?.model;
				if (msg?.usage) {
					usage.input_tokens = msg.usage.input_tokens;
					usage.cache_creation_input_tokens = msg.usage.cache_creation_input_tokens;
					usage.cache_read_input_tokens = msg.usage.cache_read_input_tokens;
					usage.output_tokens = msg.usage.output_tokens;
				}
				break;
			}
			case "content_block_start": {
				const idx = ev.index as number;
				blocks[idx] = { ...(ev.content_block as Block) };
				jsonParts[idx] = "";
				break;
			}
			case "content_block_delta": {
				const idx = ev.index as number;
				const delta = ev.delta as { type: string; text?: string; partial_json?: string };
				if (delta.type === "text_delta") {
					(blocks[idx] as { text?: string }).text =
						((blocks[idx] as { text?: string }).text ?? "") + (delta.text ?? "");
					if (delta.text) onText?.(delta.text);
				} else if (delta.type === "input_json_delta") {
					jsonParts[idx] += delta.partial_json ?? "";
				}
				break;
			}
			case "content_block_stop": {
				const idx = ev.index as number;
				const b = blocks[idx];
				if (b && b.type === "tool_use") {
					try {
						(b as { input?: unknown }).input = jsonParts[idx] ? JSON.parse(jsonParts[idx]) : {};
					} catch {
						(b as { input?: unknown }).input = {};
					}
				}
				break;
			}
			case "message_delta": {
				const delta = ev.delta as { stop_reason?: string } | undefined;
				if (delta?.stop_reason) stop_reason = delta.stop_reason;
				const u = ev.usage as { output_tokens?: number } | undefined;
				if (u?.output_tokens != null) usage.output_tokens = u.output_tokens;
				break;
			}
			case "error":
				throw new Error(`Anthropic stream error: ${JSON.stringify(ev.error)}`);
		}
	};

	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let sep: number;
		while ((sep = buffer.indexOf("\n\n")) !== -1) {
			const frame = buffer.slice(0, sep);
			buffer = buffer.slice(sep + 2);
			const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
			if (!dataLine) continue;
			const json = dataLine.slice(5).trim();
			if (json) handle(JSON.parse(json));
		}
	}

	return { content: blocks.filter(Boolean), stop_reason, usage, model };
}

function extractText(content: Block[]): string {
	return content
		.filter((b) => b.type === "text")
		.map((b) => (b as { text?: string }).text ?? "")
		.join("");
}

// Perth is UTC+8 and never observes DST, so a fixed offset is exact. The "next
// event" query is anchored to Perth days: all-day rows live at Perth-midnight,
// so today's lower bound must be Perth-midnight (not UTC midnight) or today's
// all-day events leak out of the window.
const PERTH_OFFSET_MS = 8 * 60 * 60 * 1000;

// The UTC instant of Perth-midnight today. `Date.UTC(y,m,d)` is that date at
// 00:00 UTC; Perth-midnight is 8h earlier, so subtract the offset.
export function perthMidnightToday(now: Date): string {
	const perth = new Date(now.getTime() + PERTH_OFFSET_MS);
	const y = perth.getUTCFullYear();
	const m = perth.getUTCMonth();
	const d = perth.getUTCDate();
	return new Date(Date.UTC(y, m, d) - PERTH_OFFSET_MS).toISOString();
}

// The Workshop agenda's horizon: today through ~30 Perth days out.
const AGENDA_HORIZON_DAYS = 30;

// The Perth calendar date (YYYY-MM-DD) `offsetDays` from today. read_calendar
// filters on UTC `::date`, so the agenda route pads its window a day each side
// with this and lets the Perth-aware client do the authoritative bucketing.
export function perthDate(now: Date, offsetDays: number): string {
	const perth = new Date(now.getTime() + PERTH_OFFSET_MS);
	return new Date(
		Date.UTC(perth.getUTCFullYear(), perth.getUTCMonth(), perth.getUTCDate() + offsetDays),
	)
		.toISOString()
		.slice(0, 10);
}

// One read_calendar row, narrowed to the fields the agenda renders.
type AgendaRow = {
	id: number;
	title: string;
	starts_at: string | null;
	ends_at: string | null;
	is_datetime: boolean;
	kind: string;
	source: string;
	course: string | null;
	url: string | null;
	recurs_annual: boolean | null;
};

// The two "next" candidates and the timed-first rule between them. An all-day
// row sits at Perth-midnight, which would always sort before any clock time on
// the same day — so a same-day appointment would be shadowed all day. Instead we
// sort an all-day event at the END of its Perth day (+24h; Perth has no DST, so
// this is exact). A still-upcoming timed event then surfaces ahead of a same-day
// all-day one; the all-day banner only wins once that timed event has passed, or
// across days where it's genuinely the sooner thing.
export type NextRow = { title: string; starts_at: string; is_datetime: boolean };
export function pickNext(timed: NextRow | null, allDay: NextRow | null): NextRow | null {
	if (!timed) return allDay;
	if (!allDay) return timed;
	const DAY_MS = 24 * 60 * 60 * 1000;
	const allDayKey = new Date(allDay.starts_at).getTime() + DAY_MS; // end of its Perth day
	return new Date(timed.starts_at).getTime() <= allDayKey ? timed : allDay;
}

// The single next event for the ambient tile, shared by GET /api/calendar and the
// composed GET /api/ambient. Two candidates — the earliest still-future timed
// event and the earliest all-day event whose Perth day hasn't ended — fetched
// apart so a same-day all-day row can't shadow a timed one, then pickNext()
// applies the timed-first rule. Lessons are excluded (the tile is for events, not
// the class register). Throws on a query error so the caller owns the status.
async function nextEvent(supabase: SupabaseClient, now: Date): Promise<NextRow | null> {
	const nowISO = now.toISOString();
	const perthMidnight = perthMidnightToday(now);
	const [timedRes, allDayRes] = await Promise.all([
		supabase
			.from("calendar_mirror")
			.select("title, starts_at, is_datetime")
			.neq("kind", "lesson")
			.eq("is_datetime", true)
			.gte("starts_at", nowISO)
			.order("starts_at", { ascending: true })
			.limit(1),
		supabase
			.from("calendar_mirror")
			.select("title, starts_at, is_datetime")
			.neq("kind", "lesson")
			.eq("is_datetime", false)
			.gte("starts_at", perthMidnight)
			.order("starts_at", { ascending: true })
			.limit(1),
	]);
	const error = timedRes.error ?? allDayRes.error;
	if (error) throw new Error(error.message);
	return pickNext(timedRes.data?.[0] ?? null, allDayRes.data?.[0] ?? null);
}

/**
 * Run the brain to a final reply, executing any tools it calls along the way.
 *
 * The deliberate-lookup loop: call the API with the active tools; while it asks
 * for a tool, run the tool (best-effort), feed the result back, and call again —
 * capped at maxToolIterations so it can never run away. Tool failures come back
 * as is_error results, so the model recovers and still lands a reply.
 *
 * `activeTools` is this turn's tool state: seeded with the resident set
 * (search_tools + write_memory), grown when the model calls search_tools. The
 * model asks; the Worker never injects a selection unprompted. Loaded
 * definitions live only for this turn — the next message starts resident-only.
 */
async function runBrain(
	env: Env,
	supabase: SupabaseClient,
	system: SystemPrompt,
	messages: BrainMessage[],
	emit?: (ev: BrainEvent) => void,
	extras?: ToolExtras,
): Promise<{ reply: string; cost: CostSummary }> {
	const convo: BrainMessage[] = [...messages];
	// Forward the model's text to the client as it streams. Undefined when no one
	// is listening (the reply is still assembled the same way).
	const onText = emit ? (delta: string) => emit({ type: "delta", text: delta }) : undefined;

	// Sum usage across every call this exchange makes — the tool loop can fire
	// several. Captured here because the response's `usage` is the only place
	// this number ever exists; it can't be recovered after the fact.
	const cost: CostSummary = {
		input_tokens: 0,
		output_tokens: 0,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
		api_calls: 0,
		model: "",
	};
	const tally = (u?: Usage, model?: string) => {
		cost.input_tokens += u?.input_tokens ?? 0;
		cost.output_tokens += u?.output_tokens ?? 0;
		cost.cache_creation_input_tokens += u?.cache_creation_input_tokens ?? 0;
		cost.cache_read_input_tokens += u?.cache_read_input_tokens ?? 0;
		cost.api_calls += 1;
		if (model) cost.model = model;
	};

	// The identity/capability context (Haven fork): resolves every {user} /
	// {companion} / roster token in tool text, and gates search results on the
	// keys this install actually holds. One build per exchange.
	const toolCtx = await buildToolContext(env, supabase);

	const activeTools = residentDefinitions();
	let response = await callAnthropic(env, system, convo, resolveDefinitions(activeTools, toolCtx), onText);
	tally(response.usage, response.model);
	let iterations = 0;

	while (
		response.stop_reason === "tool_use" &&
		iterations < RETRIEVAL_CONFIG.maxToolIterations
	) {
		iterations++;
		// A tool round is starting — let the client swap "…" for "(looking that up…)"
		// over the silence while the lookup runs.
		emit?.({ type: "status", label: "looking that up" });
		convo.push({ role: "assistant", content: response.content });

		const results: Block[] = [];
		for (const block of response.content) {
			if (block.type !== "tool_use") continue;
			const tu = block as unknown as {
				id: string;
				name: string;
				input: Record<string, unknown>;
			};

			// search_tools is resolved here, not in runTool: loading a tool means
			// appending its definition to THIS loop's activeTools so the next API
			// call accepts it. A miss is a graceful is_error, never a throw.
			if (tu.name === "search_tools") {
				const need = String((tu.input ?? {}).need ?? "").trim();
				const matches = searchTools(need, toolCtx);
				console.log(
					`search_tools("${need}") → ${
						matches.length
							? matches.map((m) => m.definition.name).join(", ")
							: "no match"
					}`,
				);
				if (matches.length === 0) {
					results.push({
						type: "tool_result",
						tool_use_id: tu.id,
						content: noMatchMessage(need),
						is_error: true,
					});
				} else {
					for (const m of matches) {
						if (!activeTools.some((t) => t.name === m.definition.name)) {
							activeTools.push(m.definition);
						}
					}
					results.push({
						type: "tool_result",
						tool_use_id: tu.id,
						content: shortlistMessage(matches, toolCtx),
					});
				}
				continue;
			}

			const r = await runTool(env, supabase, tu.name, tu.input ?? {}, extras);
			console.log(`tool ${tu.name} → ${r.is_error ? `error: ${r.content}` : "ok"}`);
			results.push({
				type: "tool_result",
				tool_use_id: tu.id,
				content: r.content,
				...(r.is_error ? { is_error: true } : {}),
			});
		}
		convo.push({ role: "user", content: results });
		response = await callAnthropic(env, system, convo, resolveDefinitions(activeTools, toolCtx), onText);
		tally(response.usage, response.model);
	}

	const reply =
		extractText(response.content) || "(I got tangled looking that up — say that again?)";
	return { reply, cost };
}

// ── Serve-time identity dressing (Haven fork) ────────────────────────────────
// The repo ships neutral branding ("Haven OS" in index.html, the manifest and
// the login card); the Worker swaps in the configured house name at serve
// time, exactly the Décor injection pattern. auth.ts stays byte-identical —
// the login RESPONSE is transformed here, the login logic never is.

const escapeHtml = (s: string): string =>
	s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");

/** Swap the neutral house name in a served HTML document. */
function dressHtmlIdentity(html: string, houseName: string): string {
	const safe = escapeHtml(houseName);
	return html
		.replaceAll("<title>Haven OS</title>", `<title>${safe}</title>`)
		.replaceAll('content="Haven OS"', `content="${safe}"`);
}

/** The login page, wearing the configured house name. Best-effort — a failed
 * profile read serves the untouched page rather than costing the front door. */
async function dressedLoginPage(env: Env, supabase: SupabaseClient): Promise<Response> {
	const page = loginPage();
	try {
		const profile = await loadIdentityProfile(env, supabase);
		const safe = escapeHtml(profile.house_name);
		const html = (await page.text())
			.replaceAll("<title>Vale OS</title>", `<title>${safe}</title>`)
			.replaceAll("<h1>Vale OS</h1>", `<h1>${safe}</h1>`);
		return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
	} catch (err) {
		console.error("login page identity dressing failed (serving plain):", err);
		return loginPage();
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const isApi = url.pathname.startsWith("/api/");

		// Preflight.
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS });
		}

		// The gate is live in production only; the sandbox runs open.
		const enforceAuth = env.ENVIRONMENT === "production";

		// Fail loud, not silent, if the session secret was never set — otherwise
		// sessions would be signed with an empty, guessable key, with no clue why.
		// (VALE_PASSWORD is no longer required per se: a Haven install stores a
		// wizard-set hash instead — see setup.ts. Neither present = first-run.)
		if (enforceAuth && !env.SESSION_SECRET) {
			const msg =
				"This install is missing its SESSION_SECRET secret. Set it with: npx wrangler secret put SESSION_SECRET (or via the deploy screen).";
			return isApi
				? Response.json({ ok: false, error: msg }, { status: 500, headers: CORS })
				: new Response(msg, {
						status: 500,
						headers: { "Content-Type": "text/plain" },
					});
		}

		// A service-role client for the pre-gate paths (virgin detection, hash
		// login, identity-dressed shell). Construction is local and cheap — no
		// network until a query runs, so asset requests pay nothing for it.
		const gateDb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
			auth: { persistSession: false, autoRefreshToken: false },
		});

		// ── First-run wizard (Haven fork, 19 Jul 2026). Virgin = production, no
		// env password, no stored hash — our install (env password set) skips the
		// DB read entirely and can never present as virgin. While virgin, the
		// Worker serves the shell (the React wizard inside it) and the narrow
		// /api/setup surface; every other API answers 403. auth.ts untouched —
		// the wizard precedes the gate, it does not modify it. ─────────────────
		let setupRequiredNow = false;
		if (enforceAuth && !env.VALE_PASSWORD) {
			try {
				setupRequiredNow = await setupRequired(env, gateDb);
			} catch (err) {
				const msg = `Can't reach the database to check setup state: ${(err as Error).message}`;
				return isApi
					? Response.json({ ok: false, error: msg }, { status: 500, headers: CORS })
					: new Response(msg, { status: 500, headers: { "Content-Type": "text/plain" } });
			}
		}

		// The doorbell every boot rings: answers pre-gate on purpose (it reveals
		// only whether setup has run — the same fact the login page reveals).
		if (request.method === "GET" && url.pathname === "/api/setup/status") {
			return Response.json(
				{ ok: true, setup_required: setupRequiredNow },
				{ headers: CORS },
			);
		}

		if (setupRequiredNow) {
			const handled = await handleSetupRequest(request, url, env, gateDb);
			if (handled) return handled;
			if (isApi) {
				return Response.json(
					{ ok: false, error: "This install needs first-run setup." },
					{ status: 403, headers: CORS },
				);
			}
			// Serve the shell so the wizard (inside the React app) renders. No
			// decor/identity dressing — a virgin house is neutral by definition.
			const res = await env.ASSETS.fetch(request);
			if ((res.headers.get("Content-Type") ?? "").includes("text/html")) {
				const headers = new Headers(res.headers);
				headers.set("Cache-Control", "no-cache");
				return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
			}
			return res;
		}

		// ── POST /api/login — the one route that works while logged out ────────
		if (request.method === "POST" && url.pathname === "/api/login") {
			let body: { password?: unknown };
			try {
				body = await request.json();
			} catch {
				return Response.json(
					{ ok: false, error: "Body must be JSON." },
					{ status: 400, headers: CORS },
				);
			}
			if (!enforceAuth) {
				return Response.json({ ok: true }, { headers: CORS });
			}
			if (await checkHousePassword(env, gateDb, body.password)) {
				return Response.json(
					{ ok: true },
					{ headers: { ...CORS, "Set-Cookie": await sessionCookie(env.SESSION_SECRET) } },
				);
			}
			return Response.json({ ok: false }, { status: 401, headers: CORS });
		}

		// ── POST /mcp — ChatJay's door (the Gallery's third). Sits BEFORE the
		// session gate because its caller is a connector, not a browser: it has no
		// cookie and never will. It carries its own lock instead — the
		// GALLERY_MCP_TOKEN bearer check inside handleMcp — so this placement
		// trades one gate for another, never removes one. auth.ts untouched. ─────
		if (url.pathname === "/mcp") {
			return handleMcp(request, env, ctx);
		}

		// The /mcp door's OAuth face (claude.ai's connector UI speaks only
		// OAuth): discovery metadata is public by spec; the authorize page
		// carries its own house-password check; codes and tokens verify
		// statelessly. Same lock, different handshake — also before the gate.
		if (url.pathname.startsWith("/.well-known/oauth-") || url.pathname.startsWith("/oauth/")) {
			return handleOAuth(request, env);
		}

		// ── The gate. Past here, the request is authenticated (or in dev). ─────
		// A valid-but-past-halfway token yields a renewal cookie, attached below to
		// the thread-heartbeat responses (/api/history + /api/message) — the
		// reliably-frequent authed JSON calls. Static-asset responses come back from
		// ASSETS with immutable headers, so they can't carry it; the heartbeat can.
		let renewCookie: string | null = null;
		if (enforceAuth) {
			const session = await sessionStatus(request, env.SESSION_SECRET);
			if (!session.valid) {
				return isApi
					? Response.json({ ok: false, error: "Not authorised." }, { status: 401, headers: CORS })
					: dressedLoginPage(env, gateDb);
			}
			if (session.renew) renewCookie = await sessionCookie(env.SESSION_SECRET);
		}

		// ── The Fuse Box side gate (v0.3 brief, Phase 1). Panel routes live past
		// the house gate above — you must already be *in* the house — and behind
		// a second, shorter lock: the same key, re-asked, minting a separate
		// 15-minute token (domain-separated from the house session; fusebox.ts).
		// Login and status are the only routes outside the lock. Locked 401s
		// carry `locked: true` so the client re-prompts for the panel key instead
		// of treating it as a dead house session and reloading. ─────────────────
		if (url.pathname.startsWith("/api/fusebox/")) {
			if (request.method === "POST" && url.pathname === "/api/fusebox/login") {
				let body: { password?: unknown };
				try {
					body = await request.json();
				} catch {
					return Response.json(
						{ ok: false, error: "Body must be JSON." },
						{ status: 400, headers: CORS },
					);
				}
				if (!enforceAuth) {
					// The sandbox runs open, matching the front door.
					return Response.json(
						{ ok: true, ttl_seconds: FUSEBOX_TTL_MS / 1000 },
						{ headers: CORS },
					);
				}
				if (await checkHousePassword(env, gateDb, body.password)) {
					return Response.json(
						{ ok: true, ttl_seconds: FUSEBOX_TTL_MS / 1000 },
						{ headers: { ...CORS, "Set-Cookie": await fuseboxCookie(env.SESSION_SECRET) } },
					);
				}
				return Response.json(
					{ ok: false, error: "Wrong key.", locked: true },
					{ status: 401, headers: CORS },
				);
			}

			const fusebox = enforceAuth
				? await fuseboxStatus(request, env.SESSION_SECRET)
				: { unlocked: true, remainingMs: FUSEBOX_TTL_MS };

			// The doorbell: reports lock state without needing the token (it's how
			// the client decides whether to prompt), so it answers 200 either way.
			if (request.method === "GET" && url.pathname === "/api/fusebox/status") {
				return Response.json(
					{
						ok: true,
						unlocked: fusebox.unlocked,
						remaining_seconds: Math.floor(fusebox.remainingMs / 1000),
					},
					{ headers: CORS },
				);
			}

			if (!fusebox.unlocked) {
				return Response.json(
					{ ok: false, error: "Fuse Box locked.", locked: true },
					{ status: 401, headers: CORS },
				);
			}

			// One service-role client for every circuit behind the side gate. Created
			// up here since the keys circuit's store-coordinate resolution (Haven
			// fork) reads preferences too.
			const fuseboxDb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
				auth: { persistSession: false, autoRefreshToken: false },
			});

			// ── The keys circuit (Phase 2) — a fixed registry over the write-only
			// Secrets Store. Values go in, metadata comes back, values never do. ──
			if (request.method === "GET" && url.pathname === "/api/fusebox/keys") {
				const listed = await listKeys(env, fuseboxDb);
				return listed.ok
					? Response.json({ ok: true, keys: listed.keys }, { headers: CORS })
					: Response.json({ ok: false, error: listed.error }, { status: 500, headers: CORS });
			}

			const keyMatch = url.pathname.match(/^\/api\/fusebox\/keys\/([A-Z0-9_]+)$/);
			if (request.method === "PUT" && keyMatch) {
				let body: { value?: unknown };
				try {
					body = await request.json();
				} catch {
					return Response.json(
						{ ok: false, error: "Body must be JSON." },
						{ status: 400, headers: CORS },
					);
				}
				const saved = await saveKey(env, fuseboxDb, keyMatch[1], body.value);
				return saved.ok
					? Response.json({ ok: true, created: saved.created }, { headers: CORS })
					: Response.json({ ok: false, error: saved.error }, { status: 400, headers: CORS });
			}

			const testMatch = url.pathname.match(/^\/api\/fusebox\/keys\/([A-Z0-9_]+)\/test$/);
			if (request.method === "POST" && testMatch) {
				// `ok` here is the test VERDICT, not transport success — the client
				// renders it as the pass/fail note either way.
				const tested = await testKey(env, testMatch[1]);
				return Response.json(tested, { headers: CORS });
			}

			// ── The Identity circuit (Phase 3) — the versioned static prompt and
			// the voice identity. Append-only versions; restore is a pointer flip
			// (the Snuffles test); voice is a preferences row. ────────────────────
			if (request.method === "GET" && url.pathname === "/api/fusebox/prompt") {
				const { data, error } = await fuseboxDb
					.from("prompt_versions")
					.select("id, content, note, created_at, is_active")
					.order("created_at", { ascending: false });
				if (error) {
					return Response.json({ ok: false, error: error.message }, { status: 500, headers: CORS });
				}
				const active = (data ?? []).find((v) => v.is_active) ?? null;
				return Response.json(
					{
						ok: true,
						active: active
							? { id: active.id, content: active.content, note: active.note, created_at: active.created_at }
							: null,
						versions: (data ?? []).map((v) => ({
							id: v.id,
							note: v.note,
							created_at: v.created_at,
							chars: v.content.length,
							is_active: v.is_active,
						})),
					},
					{ headers: CORS },
				);
			}

			if (request.method === "POST" && url.pathname === "/api/fusebox/prompt") {
				let body: { content?: unknown; note?: unknown };
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				const content = typeof body.content === "string" ? body.content : "";
				if (!content.trim()) {
					return Response.json({ ok: false, error: "The prompt must not be empty." }, { status: 400, headers: CORS });
				}
				const { data, error } = await fuseboxDb.rpc("save_prompt_version", {
					p_content: content,
					p_note: typeof body.note === "string" && body.note.trim() ? body.note.trim() : null,
				});
				if (error) {
					return Response.json({ ok: false, error: error.message }, { status: 500, headers: CORS });
				}
				return Response.json({ ok: true, id: data }, { headers: CORS });
			}

			const promptPreview = url.pathname.match(/^\/api\/fusebox\/prompt\/([0-9a-f-]{36})$/);
			if (request.method === "GET" && promptPreview) {
				const { data, error } = await fuseboxDb
					.from("prompt_versions")
					.select("id, content, note, created_at, is_active")
					.eq("id", promptPreview[1])
					.maybeSingle();
				if (error || !data) {
					return Response.json({ ok: false, error: error?.message ?? "No such version." }, { status: 404, headers: CORS });
				}
				return Response.json({ ok: true, version: data }, { headers: CORS });
			}

			const promptRestore = url.pathname.match(/^\/api\/fusebox\/prompt\/([0-9a-f-]{36})\/restore$/);
			if (request.method === "POST" && promptRestore) {
				const { error } = await fuseboxDb.rpc("activate_prompt_version", { p_id: promptRestore[1] });
				if (error) {
					return Response.json({ ok: false, error: error.message }, { status: 500, headers: CORS });
				}
				return Response.json({ ok: true }, { headers: CORS });
			}

			if (request.method === "GET" && url.pathname === "/api/fusebox/voice") {
				const { data, error } = await fuseboxDb
					.from("preferences")
					.select("value")
					.eq("key", "identity.voice")
					.maybeSingle();
				if (error) {
					return Response.json({ ok: false, error: error.message }, { status: 500, headers: CORS });
				}
				const v = (data?.value ?? {}) as { voice_id?: string; model_id?: string };
				return Response.json(
					{ ok: true, voice_id: v.voice_id ?? "", model_id: v.model_id ?? "" },
					{ headers: CORS },
				);
			}

			if (request.method === "PUT" && url.pathname === "/api/fusebox/voice") {
				let body: { voice_id?: unknown; model_id?: unknown };
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				const voiceId = typeof body.voice_id === "string" ? body.voice_id.trim() : "";
				const modelId = typeof body.model_id === "string" ? body.model_id.trim() : "";
				if (!voiceId || !modelId) {
					return Response.json(
						{ ok: false, error: "Both voice_id and model_id are required." },
						{ status: 400, headers: CORS },
					);
				}
				const { error } = await fuseboxDb.from("preferences").upsert(
					{
						key: "identity.voice",
						value: { voice_id: voiceId, model_id: modelId },
						updated_at: new Date().toISOString(),
					},
					{ onConflict: "key" },
				);
				if (error) {
					return Response.json({ ok: false, error: error.message }, { status: 500, headers: CORS });
				}
				return Response.json({ ok: true }, { headers: CORS });
			}

			if (request.method === "POST" && url.pathname === "/api/fusebox/voice/validate") {
				// Confirms the SAVED voice_id exists on the ElevenLabs account —
				// a voices-list lookup, free, never a render.
				try {
					const [elevenKey, identity] = await Promise.all([
						getSecret(env, "ELEVENLABS_API_KEY"),
						loadVoiceIdentity(env),
					]);
					const res = await fetchWithTimeout(
						"https://api.elevenlabs.io/v1/voices",
						{ headers: { "xi-api-key": elevenKey } },
						{ service: "elevenlabs" },
					);
					if (!res.ok) {
						return Response.json(
							{ ok: true, valid: false, detail: `ElevenLabs answered ${res.status} — the key looks wrong or revoked.` },
							{ headers: CORS },
						);
					}
					const listed = (await res.json()) as { voices?: Array<{ voice_id: string; name?: string }> };
					const match = (listed.voices ?? []).find((v) => v.voice_id === identity.voiceId);
					return Response.json(
						{
							ok: true,
							valid: !!match,
							detail: match
								? `Voice found: ${match.name ?? identity.voiceId} (model ${identity.modelId}).`
								: `No voice with id ${identity.voiceId} on this ElevenLabs account.`,
						},
						{ headers: CORS },
					);
				} catch (e) {
					return Response.json(
						{ ok: true, valid: false, detail: e instanceof Error ? e.message : String(e) },
						{ headers: CORS },
					);
				}
			}

			// ── The Identity circuit's profile half (Haven fork): the names every
			// surface resolves through. Same preferences-row pattern as voice. ───
			if (request.method === "GET" && url.pathname === "/api/fusebox/identity") {
				try {
					const profile = await loadIdentityProfile(env, fuseboxDb);
					return Response.json({ ok: true, identity: profile }, { headers: CORS });
				} catch (err) {
					return Response.json(
						{ ok: false, error: (err as Error).message },
						{ status: 500, headers: CORS },
					);
				}
			}

			if (request.method === "PUT" && url.pathname === "/api/fusebox/identity") {
				let body: unknown;
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				const valid = validateIdentityProfile(body);
				if (!valid.ok) {
					return Response.json({ ok: false, error: valid.error }, { status: 400, headers: CORS });
				}
				const { error } = await fuseboxDb.from("preferences").upsert(
					{
						key: "identity.profile",
						value: valid.profile,
						updated_at: new Date().toISOString(),
					},
					{ onConflict: "key" },
				);
				if (error) {
					return Response.json({ ok: false, error: error.message }, { status: 500, headers: CORS });
				}
				return Response.json({ ok: true, identity: valid.profile }, { headers: CORS });
			}

			// ── The Memories circuit (Phase 4) — the curation surface, with the
			// embedding integrity rule enforced in fusebox-memories.ts. ──────────
			if (request.method === "GET" && url.pathname === "/api/fusebox/memories") {
				const p = url.searchParams;
				const [listed, spine] = await Promise.all([
					listMemories(fuseboxDb, {
						type: p.get("type") ?? undefined,
						category: p.get("category") ?? undefined,
						core: (p.get("core") as "core" | "non" | null) ?? undefined,
						active: (p.get("active") as "active" | "archived" | "all" | null) ?? undefined,
						q: p.get("q") ?? undefined,
					}),
					spineStats(fuseboxDb),
				]);
				return listed.ok
					? Response.json({ ok: true, memories: listed.memories, spine }, { headers: CORS })
					: Response.json({ ok: false, error: listed.error }, { status: 500, headers: CORS });
			}

			if (request.method === "POST" && url.pathname === "/api/fusebox/memories") {
				let body: Record<string, unknown>;
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				const created = await createMemory(env, fuseboxDb, body);
				return created.ok
					? Response.json({ ok: true, id: created.id }, { headers: CORS })
					: Response.json({ ok: false, error: created.error }, { status: 400, headers: CORS });
			}

			const memMatch = url.pathname.match(/^\/api\/fusebox\/memories\/([0-9a-f-]{36})$/);
			if (request.method === "PUT" && memMatch) {
				let body: Record<string, unknown>;
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				const updated = await updateMemory(env, fuseboxDb, memMatch[1], body);
				return updated.ok
					? Response.json({ ok: true, reembedded: updated.reembedded }, { headers: CORS })
					: Response.json({ ok: false, error: updated.error }, { status: 400, headers: CORS });
			}

			if (request.method === "DELETE" && memMatch) {
				const deleted = await deleteMemory(fuseboxDb, memMatch[1]);
				return deleted.ok
					? Response.json({ ok: true }, { headers: CORS })
					: Response.json({ ok: false, error: deleted.error }, { status: 500, headers: CORS });
			}

			if (request.method === "POST" && url.pathname === "/api/fusebox/memories/import") {
				let body: { rows?: unknown };
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				const imported = await importMemories(env, fuseboxDb, body.rows);
				return imported.ok
					? Response.json({ ok: true, ...imported.report }, { headers: CORS })
					: Response.json({ ok: false, error: imported.error }, { status: 400, headers: CORS });
			}

			// ── The References circuit (Phase 5) — the Gallery's reference bank,
			// with the 10 MiB getimg cap enforced at the upload door. ────────────
			if (request.method === "GET" && url.pathname === "/api/fusebox/references") {
				const listed = await listReferences(fuseboxDb);
				return listed.ok
					? Response.json({ ok: true, references: listed.references }, { headers: CORS })
					: Response.json({ ok: false, error: listed.error }, { status: 500, headers: CORS });
			}

			if (request.method === "POST" && url.pathname === "/api/fusebox/references") {
				// Multipart: text fields + optional image (required for a new slug).
				let form: FormData;
				try {
					form = await request.formData();
				} catch {
					return Response.json(
						{ ok: false, error: "Body must be multipart form data." },
						{ status: 400, headers: CORS },
					);
				}
				const file = form.get("image");
				const image =
					file instanceof File && file.size > 0
						? { bytes: await file.arrayBuffer(), size: file.size, type: file.type }
						: null;
				const saved = await upsertReference(
					env.GALLERY,
					fuseboxDb,
					{
						slug: form.get("slug"),
						kind: form.get("kind"),
						display_name: form.get("display_name"),
						description: form.get("description"),
						active: form.get("active"),
					},
					image,
				);
				return saved.ok
					? Response.json(
							{ ok: true, created: saved.created, storage_path: saved.storage_path },
							{ headers: CORS },
						)
					: Response.json({ ok: false, error: saved.error }, { status: 400, headers: CORS });
			}

			const refMatch = url.pathname.match(/^\/api\/fusebox\/references\/([0-9a-f-]{36})$/);
			if (request.method === "PUT" && refMatch) {
				let body: Record<string, unknown>;
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				const updated = await updateReference(fuseboxDb, refMatch[1], body);
				return updated.ok
					? Response.json({ ok: true }, { headers: CORS })
					: Response.json({ ok: false, error: updated.error }, { status: 400, headers: CORS });
			}

			if (request.method === "DELETE" && refMatch) {
				const deleted = await deleteReference(env.GALLERY, fuseboxDb, refMatch[1]);
				return deleted.ok
					? Response.json({ ok: true }, { headers: CORS })
					: Response.json({ ok: false, error: deleted.error }, { status: 400, headers: CORS });
			}

			// ── The Hearth registry + Workshop mappings circuits (Phase 6) — the
			// last hardcoded corners of the house, as editable config. Both are
			// preferences rows: validated here, loaded per-call by consumers. ────
			const readPref = async (key: string) => {
				const { data, error } = await fuseboxDb
					.from("preferences")
					.select("value")
					.eq("key", key)
					.maybeSingle();
				if (error) throw new Error(error.message);
				return data?.value ?? null;
			};
			const writePref = async (key: string, value: unknown) => {
				const { error } = await fuseboxDb.from("preferences").upsert(
					{ key, value, updated_at: new Date().toISOString() },
					{ onConflict: "key" },
				);
				if (error) throw new Error(error.message);
			};

			if (request.method === "GET" && url.pathname === "/api/fusebox/hearth") {
				try {
					return Response.json({ ok: true, registry: await readPref("hearth.registry") }, { headers: CORS });
				} catch (e) {
					return Response.json(
						{ ok: false, error: e instanceof Error ? e.message : String(e) },
						{ status: 500, headers: CORS },
					);
				}
			}

			if (request.method === "PUT" && url.pathname === "/api/fusebox/hearth") {
				let body: unknown;
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				const valid = validateHearthRegistry(body);
				if (!valid.ok) {
					return Response.json({ ok: false, error: valid.error }, { status: 400, headers: CORS });
				}
				try {
					await writePref("hearth.registry", valid.registry);
					return Response.json({ ok: true }, { headers: CORS });
				} catch (e) {
					return Response.json(
						{ ok: false, error: e instanceof Error ? e.message : String(e) },
						{ status: 500, headers: CORS },
					);
				}
			}

			if (request.method === "GET" && url.pathname === "/api/fusebox/hearth/available") {
				// The fetch-from-HA helper: what THIS house actually exposes, from
				// the same live read the Hearth renders — never a second HA client.
				// Vacuums and speaker→area ride the same read; the rail exposes
				// no vacuum→areas structure (verified 18 Jul), so vacuum areas
				// are typed + checked via /validate-area below.
				try {
					const home = await getHomeCached(env);
					return Response.json(
						{
							ok: true,
							lights: home.lights.map((l) => ({ name: l.name, area: l.area })),
							media: home.media.map((m) => ({ name: m.name, area: m.area })),
							vacuums: home.vacuums.map((v) => ({ name: v.name })),
						},
						{ headers: CORS },
					);
				} catch (e) {
					return Response.json(
						{ ok: false, error: e instanceof Error ? e.message : String(e) },
						{ status: 502, headers: CORS },
					);
				}
			}

			// ── The Hearth Registry extension: vacuum + audio rosters (18 Jul) ──
			if (request.method === "GET" && url.pathname === "/api/fusebox/hearth/vacuums") {
				try {
					return Response.json({ ok: true, vacuums: await readPref("hearth.vacuums") }, { headers: CORS });
				} catch (e) {
					return Response.json(
						{ ok: false, error: e instanceof Error ? e.message : String(e) },
						{ status: 500, headers: CORS },
					);
				}
			}

			if (request.method === "PUT" && url.pathname === "/api/fusebox/hearth/vacuums") {
				let body: unknown;
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				const valid = validateVacuumRoster(body);
				if (!valid.ok) {
					return Response.json({ ok: false, error: valid.error }, { status: 400, headers: CORS });
				}
				try {
					await writePref("hearth.vacuums", valid.vacuums);
					return Response.json({ ok: true }, { headers: CORS });
				} catch (e) {
					return Response.json(
						{ ok: false, error: e instanceof Error ? e.message : String(e) },
						{ status: 500, headers: CORS },
					);
				}
			}

			if (request.method === "GET" && url.pathname === "/api/fusebox/hearth/audio") {
				try {
					return Response.json({ ok: true, audio: await readPref("hearth.audio") }, { headers: CORS });
				} catch (e) {
					return Response.json(
						{ ok: false, error: e instanceof Error ? e.message : String(e) },
						{ status: 500, headers: CORS },
					);
				}
			}

			if (request.method === "PUT" && url.pathname === "/api/fusebox/hearth/audio") {
				let body: unknown;
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				const valid = validateAudioRoster(body);
				if (!valid.ok) {
					return Response.json({ ok: false, error: valid.error }, { status: 400, headers: CORS });
				}
				try {
					await writePref("hearth.audio", valid.audio);
					return Response.json({ ok: true }, { headers: CORS });
				} catch (e) {
					return Response.json(
						{ ok: false, error: e instanceof Error ? e.message : String(e) },
						{ status: 500, headers: CORS },
					);
				}
			}

			// The typed-area check: rides the rail's one side-effect-free area
			// probe (GetLiveContext filter). 200 with valid:false is a REAL "no
			// such area"; a rail failure is a 502 — "couldn't check" must never
			// read as "invalid".
			if (request.method === "POST" && url.pathname === "/api/fusebox/hearth/validate-area") {
				let body: { area?: string };
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				const area = typeof body.area === "string" ? body.area.trim() : "";
				if (!area) {
					return Response.json({ ok: false, error: "Missing area." }, { status: 400, headers: CORS });
				}
				try {
					const check = await validateArea(env, area);
					return Response.json({ ok: true, ...check }, { headers: CORS });
				} catch (e) {
					return Response.json(
						{ ok: false, error: e instanceof Error ? e.message : String(e) },
						{ status: 502, headers: CORS },
					);
				}
			}

			if (request.method === "GET" && url.pathname === "/api/fusebox/workshop") {
				try {
					return Response.json({ ok: true, mappings: await readPref("workshop.mappings") }, { headers: CORS });
				} catch (e) {
					return Response.json(
						{ ok: false, error: e instanceof Error ? e.message : String(e) },
						{ status: 500, headers: CORS },
					);
				}
			}

			if (request.method === "PUT" && url.pathname === "/api/fusebox/workshop") {
				let body: unknown;
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				const valid = validateWorkshopMappings(body);
				if (!valid.ok) {
					return Response.json({ ok: false, error: valid.error }, { status: 400, headers: CORS });
				}
				try {
					await writePref("workshop.mappings", valid.mappings);
					return Response.json({ ok: true }, { headers: CORS });
				} catch (e) {
					return Response.json(
						{ ok: false, error: e instanceof Error ? e.message : String(e) },
						{ status: 500, headers: CORS },
					);
				}
			}

			if (request.method === "GET" && url.pathname === "/api/fusebox/workshop/databases") {
				// The picker: data sources the Notion token can actually see, so
				// mappings are chosen from reality rather than typed from memory.
				try {
					const notionToken = await getSecret(env, "NOTION_TOKEN");
					const res = await fetchWithTimeout(
						"https://api.notion.com/v1/search",
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${notionToken}`,
								"Notion-Version": env.NOTION_VERSION,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({
								filter: { property: "object", value: "data_source" },
								page_size: 50,
							}),
						},
						{ service: "notion" },
					);
					if (!res.ok) {
						return Response.json(
							{ ok: false, error: `Notion search answered ${res.status}.` },
							{ status: 502, headers: CORS },
						);
					}
					const data = (await res.json()) as {
						results?: Array<{
							id: string;
							title?: Array<{ plain_text?: string }>;
						}>;
					};
					return Response.json(
						{
							ok: true,
							databases: (data.results ?? []).map((d) => ({
								id: d.id,
								title: (d.title ?? []).map((t) => t.plain_text ?? "").join("").trim() || "(untitled)",
							})),
						},
						{ headers: CORS },
					);
				} catch (e) {
					return Response.json(
						{ ok: false, error: e instanceof Error ? e.message : String(e) },
						{ status: 502, headers: CORS },
					);
				}
			}

			// ── Generic parent blocks (18 Jul brief) — the composable tier ──
			if (request.method === "GET" && url.pathname === "/api/fusebox/workshop/blocks") {
				try {
					return Response.json({ ok: true, blocks: await readPref("workshop.blocks") }, { headers: CORS });
				} catch (e) {
					return Response.json(
						{ ok: false, error: e instanceof Error ? e.message : String(e) },
						{ status: 500, headers: CORS },
					);
				}
			}

			if (request.method === "PUT" && url.pathname === "/api/fusebox/workshop/blocks") {
				let body: unknown;
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				const valid = validateWorkshopBlocks(body);
				if (!valid.ok) {
					return Response.json({ ok: false, error: valid.error }, { status: 400, headers: CORS });
				}
				try {
					await writePref("workshop.blocks", valid.blocks);
					return Response.json({ ok: true }, { headers: CORS });
				} catch (e) {
					return Response.json(
						{ ok: false, error: e instanceof Error ? e.message : String(e) },
						{ status: 500, headers: CORS },
					);
				}
			}

			// The builder's per-source property list: what THIS data source
			// actually has, so properties are ticked from reality, never typed.
			if (request.method === "GET" && url.pathname === "/api/fusebox/workshop/schema") {
				const id = url.searchParams.get("id")?.trim() ?? "";
				if (!id) {
					return Response.json({ ok: false, error: "Missing id." }, { status: 400, headers: CORS });
				}
				try {
					return Response.json(
						{ ok: true, properties: await getDataSourceSchema(env, id) },
						{ headers: CORS },
					);
				} catch (e) {
					return Response.json(
						{ ok: false, error: e instanceof Error ? e.message : String(e) },
						{ status: 502, headers: CORS },
					);
				}
			}

			// ── The Décor circuit (19 Jul brief) — themes as data, versioned ──
			// Append-only exactly like Identity: every save is a new version,
			// restore/activate is a pointer flip, at most one active across all
			// themes, zero active = the compiled-in neutral default.
			if (request.method === "GET" && url.pathname === "/api/fusebox/decor") {
				const { data, error } = await fuseboxDb
					.from("decor_theme_versions")
					.select("id, name, note, is_active, created_at")
					.order("created_at", { ascending: false });
				if (error) {
					return Response.json({ ok: false, error: error.message }, { status: 500, headers: CORS });
				}
				// Slot labels resolve {companion} from Identity — "Jay's bubble" on
				// ours, "Asher's bubble" on Haven; the keys never change.
				const labelProfile = await loadIdentityProfile(env, fuseboxDb).catch(() => null);
				const withLabels = <T extends { label: string }>(slots: readonly T[]): T[] =>
					labelProfile
						? slots.map((s) => ({ ...s, label: resolveIdentityText(s.label, labelProfile) }))
						: [...slots];
				return Response.json(
					{
						ok: true,
						versions: data ?? [],
						registry: {
							colors: withLabels(COLOR_SLOTS),
							fonts: withLabels(FONT_SLOTS),
							font_options: FONT_KEYS.map((key) => ({ key, stack: FONT_STACKS[key] })),
						},
					},
					{ headers: CORS },
				);
			}

			if (request.method === "POST" && url.pathname === "/api/fusebox/decor") {
				let body: { name?: unknown; tokens?: unknown; note?: unknown };
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				const name = typeof body.name === "string" ? body.name.trim() : "";
				if (!name || name.length > 40) {
					return Response.json(
						{ ok: false, error: "Theme name must be 1-40 chars." },
						{ status: 400, headers: CORS },
					);
				}
				const valid = validateDecorTokens(body.tokens);
				if (!valid.ok) {
					return Response.json({ ok: false, error: valid.error }, { status: 400, headers: CORS });
				}
				const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
				const { data, error } = await fuseboxDb.rpc("save_decor_version", {
					p_name: name,
					p_tokens: valid.tokens,
					p_note: note,
				});
				if (error) {
					return Response.json({ ok: false, error: error.message }, { status: 500, headers: CORS });
				}
				return Response.json({ ok: true, id: data }, { headers: CORS });
			}

			// Import step 1 of 2: parse a pasted :root-style token file into an
			// honest mapping report (mapped / unmapped / unfilled). Nothing is
			// saved here — the client shows the report, Elle confirms, and the
			// confirmed tokens come back through the normal save route above.
			if (request.method === "POST" && url.pathname === "/api/fusebox/decor/import-parse") {
				let body: { text?: unknown };
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				const text = typeof body.text === "string" ? body.text : "";
				if (!text.trim()) {
					return Response.json({ ok: false, error: "Paste a token file first." }, { status: 400, headers: CORS });
				}
				if (text.length > 100_000) {
					return Response.json(
						{ ok: false, error: "That paste is over 100 KB — not a token file." },
						{ status: 400, headers: CORS },
					);
				}
				return Response.json({ ok: true, report: parseDecorImport(text) }, { headers: CORS });
			}

			if (request.method === "POST" && url.pathname === "/api/fusebox/decor/deactivate") {
				const { error } = await fuseboxDb.rpc("deactivate_decor");
				if (error) {
					return Response.json({ ok: false, error: error.message }, { status: 500, headers: CORS });
				}
				return Response.json({ ok: true }, { headers: CORS });
			}

			const decorVersion = url.pathname.match(/^\/api\/fusebox\/decor\/([0-9a-f-]{36})$/);
			if (request.method === "GET" && decorVersion) {
				const { data, error } = await fuseboxDb
					.from("decor_theme_versions")
					.select("id, name, note, is_active, created_at, tokens")
					.eq("id", decorVersion[1])
					.maybeSingle();
				if (error || !data) {
					return Response.json(
						{ ok: false, error: error?.message ?? "No such version." },
						{ status: error ? 500 : 404, headers: CORS },
					);
				}
				const tokens = sanitizeDecorTokens(data.tokens);
				return Response.json(
					{
						ok: true,
						version: {
							id: data.id,
							name: data.name,
							note: data.note,
							is_active: data.is_active,
							created_at: data.created_at,
							tokens,
							// Ready-to-wear CSS for the panel's in-session preview.
							css: decorCss(tokens),
						},
					},
					{ headers: CORS },
				);
			}

			const decorActivate = url.pathname.match(/^\/api\/fusebox\/decor\/([0-9a-f-]{36})\/activate$/);
			if (request.method === "POST" && decorActivate) {
				const { error } = await fuseboxDb.rpc("activate_decor_version", { p_id: decorActivate[1] });
				if (error) {
					return Response.json({ ok: false, error: error.message }, { status: 500, headers: CORS });
				}
				return Response.json({ ok: true }, { headers: CORS });
			}

			// Later circuits land here, already behind the lock.
			return Response.json({ ok: false, error: "No such fuse." }, { status: 404, headers: CORS });
		}

		// ── GET /api/decor/active — the theme the house wears right now. The
		// runtime fetches this on load, applies it, and keeps a last-good copy in
		// localStorage so an offline cold start paints correctly. css is null
		// when no theme is active — the client clears its copy and the compiled
		// neutral default shows through. Session-gated like every /api route. ───
		if (request.method === "GET" && url.pathname === "/api/decor/active") {
			try {
				const active = await loadActiveDecor(env);
				return Response.json(
					{
						ok: true,
						active: active ? { id: active.id, name: active.name } : null,
						css: active ? decorCss(active.tokens) : null,
					},
					{ headers: CORS },
				);
			} catch (e) {
				return Response.json(
					{ ok: false, error: e instanceof Error ? e.message : String(e) },
					{ status: 500, headers: CORS },
				);
			}
		}

		const supabase = createClient(
			env.SUPABASE_URL,
			env.SUPABASE_SERVICE_ROLE_KEY,
			{ auth: { persistSession: false, autoRefreshToken: false } },
		);

		// ── POST /api/message — talk to Jay. The server owns the thread now: the
		// client sends only the new message; history is loaded here (prod from
		// Supabase, dev from the module-scope thread), so two devices share one
		// conversation and a stale client can't overwrite Jay's canon. ─────────
		if (request.method === "POST" && url.pathname === "/api/message") {
			let body: { text?: unknown };
			try {
				body = await request.json();
			} catch {
				return Response.json(
					{ ok: false, error: "Body must be JSON." },
					{ status: 400, headers: CORS },
				);
			}
			const text = typeof body.text === "string" ? body.text.trim() : "";
			if (!text) {
				return Response.json(
					{ ok: false, error: "No message to reply to." },
					{ status: 400, headers: CORS },
				);
			}

			// TODO(scene): derive include_scene from room context (Bedroom active /
			// explicit scene signal) per Memory Architecture §4. The front-end doesn't
			// send room context to /api/message yet, so default false until it does.
			const includeScene = false;
			const isProd = env.ENVIRONMENT === "production";

			// ── Pre-brain assembly. Everything that can fail with a clean HTTP status
			// happens BEFORE the stream opens — once we're streaming (200 + SSE) the
			// only way to report a failure is an in-band `error` event. So resolve
			// history and build the prompt here (dev from the module-scope thread,
			// prod from Supabase); brain output and reply-persistence stream below.
			let messages: BrainMessage[];
			let system: SystemPrompt;
			let conversationId = ""; // prod only

			if (!isProd) {
				// Dev sandbox: persistence is off, so the module-scope thread stands in
				// as history — enough to give local chat short-term context.
				devThread.push({ from: "elle", text });
				messages = toAnthropicMessages(devThread, RETRIEVAL_CONFIG.historyBufferMessages);
				try {
					system = await buildSystemPrompt(supabase, env, devThread.map((m) => m.text), includeScene);
				} catch (e) {
					devThread.pop(); // drop the unanswered turn so a retry doesn't double it
					return Response.json(
						{ ok: false, error: e instanceof Error ? e.message : String(e) },
						{ status: 500, headers: CORS },
					);
				}
			} else {
				// Production: Supabase owns the thread. Save Elle's turn FIRST — a brain
				// failure must never lose her words; on restore her message shows
				// unanswered, which is the truth. Unlike Jay's reply (best-effort below),
				// this save failing is a real error she should see.
				try {
					conversationId = await getOrCreateActiveConversation(supabase, "front_room");
					await saveMessage(supabase, conversationId, "elle", text);
				} catch (err) {
					return Response.json(
						{ ok: false, error: (err as Error).message },
						{ status: 500, headers: CORS },
					);
				}

				// Load the recent window (now including the just-saved turn) — the
				// brain's history buffer. Never the whole thread.
				let recentWindow: Awaited<ReturnType<typeof loadRecentMessages>>;
				try {
					recentWindow = await loadRecentMessages(
						supabase,
						conversationId,
						RETRIEVAL_CONFIG.historyBufferMessages,
					);
				} catch (err) {
					return Response.json(
						{ ok: false, error: (err as Error).message },
						{ status: 500, headers: CORS },
					);
				}
				messages = toAnthropicMessages(
					recentWindow.map((m) => ({ from: m.from as "elle" | "jay", text: m.text })),
					RETRIEVAL_CONFIG.historyBufferMessages,
				);
				// The whole of what Jay knows before this conversation: static core +
				// always-on spine + memories retrieved for this exact moment.
				try {
					system = await buildSystemPrompt(supabase, env, recentWindow.map((m) => m.text), includeScene);
				} catch (err) {
					return Response.json(
						{ ok: false, error: (err as Error).message },
						{ status: 500, headers: CORS },
					);
				}
			}

			// ── Stream the reply as SSE. `delta` events carry text as it arrives, a
			// `status` event marks a tool round (the client swaps "…" for "looking that
			// up…"), and a final `done` carries created_at + cost. Persistence runs
			// after the stream via ctx.waitUntil (keeping the isolate alive for the
			// tail write). A mid-stream failure is an `error` event — the client keeps
			// the partial text, marks it local, and reconciles against the persisted
			// truth on the next history fetch.
			const { readable, writable } = new TransformStream();
			const writer = writable.getWriter();
			const encoder = new TextEncoder();
			const sse = (event: string, data: unknown) =>
				writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

			const streamTail = (async () => {
				try {
					const { reply, cost } = await runBrain(
						env,
						supabase,
						system,
						messages,
						(ev) => {
							if (ev.type === "delta") void sse("delta", { text: ev.text });
							else void sse("status", { label: ev.label });
						},
						// The one request-scoped extra a tool can need: generate_image's
						// pipeline outlives the tool round, and only ctx can carry it.
						{ waitUntil: (p) => ctx.waitUntil(p) },
					);

					// Persist Jay's turn — best-effort: a storage hiccup logs but never
					// costs Elle the reply she's owed. created_at rides the done event so
					// the client can reconcile its optimistic bubble.
					let created_at = new Date().toISOString();
					if (!isProd) {
						devThread.push({ from: "jay", text: reply });
					} else {
						try {
							const saved = await saveMessage(supabase, conversationId, "jay", reply, { cost });
							created_at = saved.created_at;
							await touchConversation(supabase, conversationId);
						} catch (err) {
							console.error("Reply persistence failed (reply still streamed):", err);
						}
					}
					// `reply` rides along as a safety net: if a reply produced no text
					// deltas (e.g. the tangle fallback, which is synthesised rather than
					// streamed), the client can still render it from here.
					await sse("done", { created_at, cost, reply });
				} catch (e) {
					// Brain failure mid-stream. Dev drops the unanswered turn so a retry
					// doesn't double it; prod already saved Elle's, so it survives shown
					// unanswered. The partial (if any) stays on the client, marked local.
					if (!isProd) devThread.pop();
					await sse("error", { error: e instanceof Error ? e.message : String(e) });
				} finally {
					await writer.close();
				}
			})();
			ctx.waitUntil(streamTail);

			return new Response(readable, {
				headers: {
					...CORS,
					"Content-Type": "text/event-stream; charset=utf-8",
					"Cache-Control": "no-cache, no-transform",
					...(renewCookie ? { "Set-Cookie": renewCookie } : {}),
				},
			});
		}

		// ── GET /api/history — restore the active Front Room conversation ──────
		// The thread heartbeat: the client refetches this on every load and
		// foreground, so it also carries the sliding-session renewal cookie. The
		// ?limit= (newest tail, capped) keeps the read path from growing forever.
		if (request.method === "GET" && url.pathname === "/api/history") {
			const historyHeaders = renewCookie ? { ...CORS, "Set-Cookie": renewCookie } : CORS;
			// Sandbox restores nothing — it has nothing to restore.
			if (env.ENVIRONMENT !== "production") {
				return Response.json({ ok: true, messages: [] }, { headers: historyHeaders });
			}
			const limit = Math.min(
				Math.max(Number(url.searchParams.get("limit")) || 200, 1),
				500,
			);
			try {
				const messages = await loadActiveConversationMessages(
					supabase,
					"front_room",
					limit,
				);
				return Response.json({ ok: true, messages }, { headers: historyHeaders });
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 500, headers: CORS },
				);
			}
		}

		// ══ Voice notes (Voice Notes v1.5) ═════════════════════════════════════
		// The audio side of the Front Room thread. Rendering lives in voice.ts;
		// these routes only serve stored audio and run the say-this render. Both
		// sit behind the gate above like every /api/* route — no session, no audio.

		// ── GET /api/voice/{key} — stream one voice note's audio from R2 ───────
		// The ONLY way audio leaves the bucket (it has no public access). The key
		// is the UUID from the message's metadata.voice.key. Single-range requests
		// are honoured (mobile <audio> seeks with them); anything fancier is
		// legally ignored with a full 200. Audio is immutable per key, so the
		// browser may cache it privately — replay and screen-off playback then
		// never refetch. (The SW never caches /api/*; this is the HTTP cache.)
		{
			const voiceMatch = /^\/api\/voice\/([A-Za-z0-9-]{8,64})$/.exec(url.pathname);
			if (request.method === "GET" && voiceMatch) {
				const key = audioKey(voiceMatch[1]);
				const baseHeaders: Record<string, string> = {
					...CORS,
					"Content-Type": "audio/mpeg",
					"Accept-Ranges": "bytes",
					"Cache-Control": "private, max-age=31536000, immutable",
				};
				try {
					const rangeMatch = /^bytes=(\d+)-(\d*)$/.exec(
						request.headers.get("Range") ?? "",
					);
					if (rangeMatch) {
						const start = Number(rangeMatch[1]);
						const requestedEnd = rangeMatch[2] ? Number(rangeMatch[2]) : undefined;
						const obj = await env.VOICE_NOTES.get(key, {
							range: {
								offset: start,
								...(requestedEnd !== undefined
									? { length: requestedEnd - start + 1 }
									: {}),
							},
						});
						if (!obj) {
							return Response.json(
								{ ok: false, error: "No such voice note." },
								{ status: 404, headers: CORS },
							);
						}
						const total = obj.size;
						const end = Math.min(requestedEnd ?? total - 1, total - 1);
						return new Response(obj.body, {
							status: 206,
							headers: {
								...baseHeaders,
								"Content-Range": `bytes ${start}-${end}/${total}`,
								"Content-Length": String(end - start + 1),
							},
						});
					}
					const obj = await env.VOICE_NOTES.get(key);
					if (!obj) {
						return Response.json(
							{ ok: false, error: "No such voice note." },
							{ status: 404, headers: CORS },
						);
					}
					return new Response(obj.body, {
						headers: { ...baseHeaders, "Content-Length": String(obj.size) },
					});
				} catch {
					// R2 throws on an unsatisfiable range (offset past the end).
					return new Response(null, { status: 416, headers: CORS });
				}
			}
		}

		// ── POST /api/voice/say — perform an existing message ("Say this") ─────
		// No brain involvement at all: the message's stored text goes through the
		// render pipeline and the audio attaches to that same row — the text is
		// never touched (it already IS the canon). Idempotent: a message that
		// already has audio returns it as-is, so a re-tap can never re-render or
		// spend a second ElevenLabs call.
		if (request.method === "POST" && url.pathname === "/api/voice/say") {
			let body: { message_id?: unknown };
			try {
				body = await request.json();
			} catch {
				return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
			}
			const messageId = typeof body.message_id === "string" ? body.message_id : "";
			if (!messageId) {
				return Response.json({ ok: false, error: "Missing message_id." }, { status: 400, headers: CORS });
			}
			try {
				const row = await getMessageForVoice(supabase, messageId);
				if (row.voice) {
					return Response.json({ ok: true, voice: row.voice }, { headers: CORS });
				}
				if (row.role !== "jay") {
					return Response.json(
						{ ok: false, error: "Only Jay's messages get his voice." },
						{ status: 400, headers: CORS },
					);
				}
				// Verbatim: the row's text is canon — the performance must say it,
				// not riff on it (tags, pacing, and small sounds only).
				const note = await renderVoiceNote(env, row.content, "verbatim");
				// Merge, not clobber: Jay's turns already carry the cost blob here.
				await setMessageMetadata(supabase, messageId, {
					...row.metadata,
					...voiceMetadata(note),
				});
				console.log(`voice say: message ${messageId} → ${note.key} (${note.chars} chars)`);
				return Response.json(
					{ ok: true, voice: { key: note.key, chars: note.chars } },
					{ headers: CORS },
				);
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 502, headers: CORS },
				);
			}
		}

		// ══ The Gallery ═════════════════════════════════════════════════════════
		// Elle's door onto the one image pipeline (gallery.ts). Verbatim is the
		// default and the fence: her typed prompt reaches getimg word-for-word
		// unless she pressed Polish. All behind the session gate like every
		// /api/* route; the other two doors are the generate_image tool and /mcp.

		// ── POST /api/gallery/generate — start a generation (202 + pending row) ──
		if (request.method === "POST" && url.pathname === "/api/gallery/generate") {
			let body: {
				id?: unknown;
				prompt?: unknown;
				path?: unknown;
				model?: unknown;
				aspect_ratio?: unknown;
				resolution?: unknown;
				reference_slugs?: unknown;
			};
			try {
				body = await request.json();
			} catch {
				return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
			}
			// Body shape first (Thu's ordering) — a non-string prompt must be a 400,
			// not a crash; everything deeper is startGeneration's validation chain.
			if (typeof body.id !== "string" || typeof body.prompt !== "string") {
				return Response.json({ ok: false, error: "id and prompt must be strings." }, { status: 400, headers: CORS });
			}
			if (body.reference_slugs !== undefined && !Array.isArray(body.reference_slugs)) {
				return Response.json({ ok: false, error: "reference_slugs must be an array." }, { status: 400, headers: CORS });
			}
			const result = await startGeneration(
				env,
				supabase,
				{
					id: body.id,
					prompt: body.prompt,
					path: body.path === "authored" ? "authored" : "verbatim",
					source: "elle",
					model: typeof body.model === "string" ? body.model : DEFAULT_MODEL_ID,
					...(typeof body.aspect_ratio === "string" ? { aspect_ratio: body.aspect_ratio } : {}),
					...(typeof body.resolution === "string" ? { resolution: body.resolution } : {}),
					reference_slugs: (body.reference_slugs ?? []).filter(
						(s): s is string => typeof s === "string",
					),
				},
				(p) => ctx.waitUntil(p),
			);
			if (result.kind === "rejected") {
				return Response.json({ ok: false, error: result.error }, { status: result.status, headers: CORS });
			}
			return Response.json(
				{ ok: true, image: result.row },
				{ status: result.kind === "accepted" ? 202 : 200, headers: CORS },
			);
		}

		// ── GET /api/gallery/images — the grid, the poll, and the toolbar ───────
		// ?ids=a,b,c   → exactly those rows (the 2.5s pending poll)
		// ?since=ISO   → rows created after the stamp (cheap catch-up)
		// otherwise    → a page (?limit=, ?offset=), shaped by the toolbar:
		//   ?q=          search over both prompts (raw + rendered)
		//   ?source= ?model= ?aspect_ratio= ?favourite=true ?ref=slug
		//   ?sort=created_at|cost|resolution  ?dir=asc|desc
		// Search/sort/filter are SERVER-side by design — Thu's own known
		// limitation was client-side filtering over loaded rows (anything past
		// the first page invisible to it); we inherit the lesson, not the bug.
		if (request.method === "GET" && url.pathname === "/api/gallery/images") {
			const ids = (url.searchParams.get("ids") ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			const since = url.searchParams.get("since");
			const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 200);
			const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

			const SORTS: Record<string, string> = {
				created_at: "created_at",
				cost: "cost",
				resolution: "resolution", // '1K' < '2K' < '4K' — text order IS size order
			};
			const sort = SORTS[url.searchParams.get("sort") ?? ""] ?? "created_at";
			const ascending = url.searchParams.get("dir") === "asc";

			let query = supabase
				.from("images")
				.select("*")
				.order(sort, { ascending, nullsFirst: false })
				// Stable tiebreak so pagination never straddles equal values.
				.order("id", { ascending: true });
			if (ids.length) {
				query = query.in("id", ids.slice(0, 50));
			} else if (since) {
				query = query.gt("created_at", since);
			} else {
				const q = (url.searchParams.get("q") ?? "").trim();
				if (q) {
					// .or() syntax reserves commas and parens — swap them for
					// spaces rather than dropping the search on the floor.
					const safe = q.replace(/[,()]/g, " ").trim();
					if (safe) {
						query = query.or(`prompt_raw.ilike.%${safe}%,prompt_rendered.ilike.%${safe}%`);
					}
				}
				const source = url.searchParams.get("source");
				if (source && ["elle", "vosjay", "chatjay"].includes(source)) {
					query = query.eq("source", source);
				}
				const model = url.searchParams.get("model");
				if (model) query = query.eq("model", model);
				const ratio = url.searchParams.get("aspect_ratio");
				if (ratio) query = query.eq("aspect_ratio", ratio);
				if (url.searchParams.get("favourite") === "true") query = query.eq("favourite", true);
				const ref = url.searchParams.get("ref");
				// jsonb containment: PostgREST wants the value as a JSON string
				// (a raw array arg arrives as malformed JSON — found in preview).
				if (ref) query = query.contains("reference_images", JSON.stringify([{ slug: ref }]));
				query = query.range(offset, offset + limit - 1);
			}
			const { data, error } = await query;
			if (error) {
				return Response.json({ ok: false, error: error.message }, { status: 500, headers: CORS });
			}
			return Response.json({ ok: true, images: data }, { headers: CORS });
		}

		// ── GET /api/gallery/references — the picker's chips ────────────────────
		if (request.method === "GET" && url.pathname === "/api/gallery/references") {
			try {
				const refs = await loadActiveReferences(supabase);
				return Response.json(
					{
						ok: true,
						references: refs.map(({ slug, kind, display_name }) => ({ slug, kind, display_name })),
						models: MODEL_CATALOG,
					},
					{ headers: CORS },
				);
			} catch (err) {
				return Response.json({ ok: false, error: (err as Error).message }, { status: 500, headers: CORS });
			}
		}

		// ── GET /api/gallery/file/{images|thumbs|refs}/{name} — serve from R2 ───
		// The ONLY way gallery bytes leave the bucket for a browser (it has no
		// public access; getimg's reference fetches use presigned URLs instead).
		// Objects are immutable per key, so private caching is safe — a scroll
		// through the grid refetches nothing.
		{
			const fileMatch = /^\/api\/gallery\/file\/((?:images|thumbs|refs)\/[A-Za-z0-9._-]{1,80})$/.exec(
				url.pathname,
			);
			if (request.method === "GET" && fileMatch) {
				const obj = await env.GALLERY.get(fileMatch[1]);
				if (!obj) {
					return Response.json({ ok: false, error: "No such object." }, { status: 404, headers: CORS });
				}
				return new Response(obj.body, {
					headers: {
						...CORS,
						"Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
						"Content-Length": String(obj.size),
						"Cache-Control": "private, max-age=31536000, immutable",
					},
				});
			}
		}

		// ── POST /api/gallery/favourite — toggle the heart ──────────────────────
		if (request.method === "POST" && url.pathname === "/api/gallery/favourite") {
			let body: { id?: unknown; favourite?: unknown };
			try {
				body = await request.json();
			} catch {
				return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
			}
			if (typeof body.id !== "string" || typeof body.favourite !== "boolean") {
				return Response.json({ ok: false, error: "id (string) and favourite (boolean) required." }, { status: 400, headers: CORS });
			}
			const { error } = await supabase
				.from("images")
				.update({ favourite: body.favourite })
				.eq("id", body.id);
			if (error) {
				return Response.json({ ok: false, error: error.message }, { status: 500, headers: CORS });
			}
			return Response.json({ ok: true }, { headers: CORS });
		}

		// ── POST /api/gallery/retry — re-run an errored row, same id, same ask ──
		if (request.method === "POST" && url.pathname === "/api/gallery/retry") {
			let body: { id?: unknown };
			try {
				body = await request.json();
			} catch {
				return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
			}
			if (typeof body.id !== "string") {
				return Response.json({ ok: false, error: "id must be a string." }, { status: 400, headers: CORS });
			}
			const result = await retryGeneration(env, supabase, body.id, (p) => ctx.waitUntil(p));
			if (result.kind === "rejected") {
				return Response.json({ ok: false, error: result.error }, { status: result.status, headers: CORS });
			}
			return Response.json({ ok: true, image: result.row }, { status: 202, headers: CORS });
		}

		// ── POST /api/gallery/delete — row + both R2 objects, confirmed client-side ──
		if (request.method === "POST" && url.pathname === "/api/gallery/delete") {
			let body: { id?: unknown };
			try {
				body = await request.json();
			} catch {
				return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
			}
			if (typeof body.id !== "string") {
				return Response.json({ ok: false, error: "id must be a string." }, { status: 400, headers: CORS });
			}
			const result = await deleteImage(env, supabase, body.id);
			if (!result.ok) {
				return Response.json({ ok: false, error: result.error }, { status: result.status, headers: CORS });
			}
			return Response.json({ ok: true }, { headers: CORS });
		}

		// ── GET /api/sync-health — cron-worker health for the drawer-footer line ──
		if (request.method === "GET" && url.pathname === "/api/sync-health") {
			const { data, error } = await supabase
				.from("sync_health")
				.select("worker, ran_at, ok, error, items, last_ok_at")
				.order("worker");
			if (error) {
				return Response.json({ ok: false, error: error.message }, { status: 500, headers: CORS });
			}
			return Response.json({ ok: true, health: data }, { headers: CORS });
		}

		// ── GET /api/identity — the names every surface resolves through (Haven
		// fork): house, companion, user, timezone. Session-gated like the rooms;
		// the panel's editable half lives behind the side gate. ────────────────
		if (request.method === "GET" && url.pathname === "/api/identity") {
			try {
				const profile = await loadIdentityProfile(env, supabase);
				return Response.json({ ok: true, identity: profile }, { headers: CORS });
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 500, headers: CORS },
				);
			}
		}

		// ── GET /api/readiness — which capabilities this install holds, for the
		// rooms' honest empty states. Store-metadata + config reads only; never
		// a billable call. ─────────────────────────────────────────────────────
		if (request.method === "GET" && url.pathname === "/api/readiness") {
			try {
				const [anthropic, elevenlabs, getimg, haUrl, haToken, notion, openrouter, prefs] =
					await Promise.all([
						hasSecret(env, "ANTHROPIC_API_KEY"),
						hasSecret(env, "ELEVENLABS_API_KEY"),
						hasSecret(env, "GETIMG_API_KEY"),
						hasSecret(env, "HA_MCP_URL"),
						hasSecret(env, "HA_TOKEN"),
						hasSecret(env, "NOTION_TOKEN"),
						hasSecret(env, "OPENROUTER_API_KEY"),
						supabase
							.from("preferences")
							.select("key")
							.in("key", ["hearth.registry", "hearth.vacuums", "hearth.audio", "workshop.mappings"]),
					]);
				const have = new Set((prefs.data ?? []).map((r) => r.key));
				return Response.json(
					{
						ok: true,
						readiness: {
							anthropic,
							elevenlabs,
							getimg,
							ha: haUrl && haToken,
							notion,
							openrouter,
							spotify: Boolean(
								env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET && env.SPOTIFY_REFRESH_TOKEN,
							),
							gmail: Boolean(
								env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN,
							),
							hearth_rosters: have.has("hearth.registry"),
							workshop_mappings: have.has("workshop.mappings"),
						},
					},
					{ headers: CORS },
				);
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 500, headers: CORS },
				);
			}
		}

		// ── GET /api/rooms — the room catalogue, in display order ──────────────
		if (request.method === "GET" && url.pathname === "/api/rooms") {
			const { data, error } = await supabase
				.from("rooms")
				.select("*")
				.order("sort_order");

			if (error) {
				return Response.json(
					{ ok: false, error: error.message },
					{ status: 500, headers: CORS },
				);
			}

			return Response.json({ ok: true, rooms: data }, { headers: CORS });
		}

		// GET /api/mood — the mood Elle has currently set. Returns the canonical
		// snake_case id; the front-end maps it to the tile. Falls back to the
		// default rather than erroring on a fresh install.
		if (request.method === "GET" && url.pathname === "/api/mood") {
			try {
				const mood = await readMood(supabase);
				return Response.json({ ok: true, mood }, { headers: CORS });
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 500, headers: CORS },
				);
			}
		}

		// POST /api/mood — Elle sets her mood. Body { mood: <id> }, validated
		// against the taxonomy before it's written so nothing junk reaches the
		// prompt. The cycling tile is a "dropdown" selection; the HORNY button
		// (future) would pass its own set_via. Persists to preferences and
		// breadcrumbs awareness_signals.
		if (request.method === "POST" && url.pathname === "/api/mood") {
			let moodBody: { mood?: unknown };
			try {
				moodBody = await request.json();
			} catch {
				return Response.json(
					{ ok: false, error: "Body must be JSON." },
					{ status: 400, headers: CORS },
				);
			}
			if (!isValidMood(moodBody.mood)) {
				return Response.json(
					{ ok: false, error: "Unknown mood." },
					{ status: 400, headers: CORS },
				);
			}
			try {
				await writeMood(supabase, moodBody.mood);
				return Response.json({ ok: true, mood: moodBody.mood }, { headers: CORS });
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 500, headers: CORS },
				);
			}
		}

		// ── GET /api/calendar — the single next event for the ambient tile ─────
		// Read-only. Lessons (Elle's period-by-period timetable) are excluded —
		// the "next" tile is for events/appointments, not a class register.
		// Two candidates are fetched separately — the earliest still-future timed
		// event, and the earliest all-day event whose Perth day hasn't ended —
		// then pickNext() applies the timed-first rule between them. Fetching them
		// apart (rather than one ordered query) is what lets a same-day all-day
		// row avoid shadowing a timed one. Rendering (Perth tz) is the client's
		// job; this stays a thin data route.
		if (request.method === "GET" && url.pathname === "/api/calendar") {
			try {
				const event = await nextEvent(supabase, new Date());
				return Response.json({ ok: true, event }, { headers: CORS });
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 500, headers: CORS },
				);
			}
		}

		// ── GET /api/ambient?lat=&lon= — the whole ambient bar in one wake ─────
		// Composes the four ambient sources (next event, weather, now-playing,
		// mood) so the client polls ONCE per tick instead of waking the phone radio
		// three times. Each source already has its own server-side cache + last-good;
		// this is thin Promise.allSettled composition, per-field null on failure so
		// one dead upstream never blanks the others. Additive — the individual routes
		// stay, since the rooms and the SW notification path still use them.
		if (request.method === "GET" && url.pathname === "/api/ambient") {
			const now = new Date();
			// Weather placement mirrors /api/weather: device coords win; otherwise
			// Cloudflare's IP geo. cf fields are strings and can be absent — tolerate.
			const qLat = parseFloat(url.searchParams.get("lat") ?? "");
			const qLon = parseFloat(url.searchParams.get("lon") ?? "");
			const hasDeviceCoords = Number.isFinite(qLat) && Number.isFinite(qLon);
			const cf = request.cf;
			const lat = hasDeviceCoords ? qLat : parseFloat(String(cf?.latitude ?? ""));
			const lon = hasDeviceCoords ? qLon : parseFloat(String(cf?.longitude ?? ""));

			const [nextR, weatherR, nowPlayingR, moodR] = await Promise.allSettled([
				nextEvent(supabase, now),
				(async () => {
					// No usable fix — null, so the client keeps its last-good tile.
					if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
					const weather = await getWeather(lat, lon);
					// Same label rule as /api/weather: device path leaves it null (client
					// reverse-geocodes precisely); IP path uses coarse cf.city → region.
					const place = hasDeviceCoords
						? null
						: (typeof cf?.city === "string" && cf.city) ||
							(typeof cf?.region === "string" && cf.region) ||
							null;
					return { ...weather, place };
				})(),
				getNowPlayingCached(env),
				readMood(supabase),
			]);

			// `next` is wrapped ({ event }) because a bare null would be ambiguous:
			// null = the calendar read FAILED this tick (client keeps last-good), while
			// { event: null } = it succeeded and genuinely nothing is coming up (client
			// clears the tile) — the same distinction GET /api/calendar makes with its
			// status code. Weather/nowPlaying/mood have no legitimate null value, so a
			// bare null on those simply means "failed, keep last-good".
			return Response.json(
				{
					ok: true,
					next: nextR.status === "fulfilled" ? { event: nextR.value } : null,
					weather: weatherR.status === "fulfilled" ? weatherR.value : null,
					nowPlaying: nowPlayingR.status === "fulfilled" ? nowPlayingR.value : null,
					mood: moodR.status === "fulfilled" ? moodR.value : null,
				},
				{ headers: renewCookie ? { ...CORS, "Set-Cookie": renewCookie } : CORS },
			);
		}

		// ── GET /api/calendar/agenda — the Workshop calendar tool's data ───────
		// Read-only agenda for today through ~30 Perth days out. Reuses the
		// existing read_calendar() SQL function (SETOF calendar_mirror), padding
		// the window a day each side because that function filters on UTC `::date`
		// while the client buckets by Perth day. Additive and entirely separate
		// from GET /api/calendar (the ambient tile's single-next-event route),
		// which is left untouched. Lessons ARE included here — the Workshop
		// calendar is a real view of Elle's days, not a glance like the tile.
		if (request.method === "GET" && url.pathname === "/api/calendar/agenda") {
			const now = new Date();
			const { data, error } = await supabase.rpc("read_calendar", {
				start_date: perthDate(now, -1),
				end_date: perthDate(now, AGENDA_HORIZON_DAYS + 1),
			});

			if (error) {
				return Response.json(
					{ ok: false, error: error.message },
					{ status: 500, headers: CORS },
				);
			}

			// Dated events only — drops the undated "planned" lessons; carry just
			// the fields the agenda renders.
			const events = ((data ?? []) as AgendaRow[])
				.filter((r) => r.starts_at != null)
				.map((r) => ({
					id: r.id,
					title: r.title,
					starts_at: r.starts_at,
					ends_at: r.ends_at,
					is_datetime: r.is_datetime,
					kind: r.kind,
					source: r.source,
					course: r.course,
					url: r.url,
					recurs_annual: r.recurs_annual,
				}));

			return Response.json({ ok: true, events }, { headers: CORS });
		}

		// ── GET /api/projects — the Workshop Projects tool's data ──────────────
		// Read-only, live from the EV25 - Projects Notion database. No mirror, no
		// cron — the locked decision in the build brief: Projects feeds one
		// occasional panel, so it reads live behind a short in-Worker cache (~60s)
		// rather than earning a sync Worker. A failed Notion read serves last-good
		// rather than blanking (handled inside getProjects). Sorting and the
		// status→pill mapping are the client's job; this stays a thin data route.
		if (request.method === "GET" && url.pathname === "/api/projects") {
			try {
				const projects = await getProjects(env);
				return Response.json({ ok: true, projects }, { headers: CORS });
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 502, headers: CORS },
				);
			}
		}

		// ── GET /api/workshop/blocks — the generic parent blocks' definitions ──
		// What the room needs to draw the tool bar: name, icon, and each source's
		// accent (so tiles know their colour). Loaded fresh per call — add a block
		// in the Fuse Box, get a card here on the next Workshop open, no deploy.
		if (request.method === "GET" && url.pathname === "/api/workshop/blocks") {
			try {
				const blocks = await loadWorkshopBlocks(env);
				return Response.json(
					{
						ok: true,
						blocks: blocks.map((b) => ({
							name: b.name,
							icon: b.icon,
							accents: Object.fromEntries(b.sources.map((s) => [s.data_source_id, s.accent])),
						})),
					},
					{ headers: CORS },
				);
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 502, headers: CORS },
				);
			}
		}

		// ── GET /api/workshop/block?name= — one generic block's merged tiles ───
		// Every source queried, tiles tagged by source, one list sorted by the
		// block's chosen property (server-side). ~60s cache + last-good inside
		// getBlockTiles — a block never blanks. Read-only, like the whole tier.
		if (request.method === "GET" && url.pathname === "/api/workshop/block") {
			const name = url.searchParams.get("name")?.trim() ?? "";
			if (!name) {
				return Response.json({ ok: false, error: "Missing name." }, { status: 400, headers: CORS });
			}
			try {
				const blocks = await loadWorkshopBlocks(env);
				const block = blocks.find((b) => b.name.toLowerCase() === name.toLowerCase());
				if (!block) {
					return Response.json(
						{ ok: false, error: `No block called "${name}".` },
						{ status: 404, headers: CORS },
					);
				}
				const tiles = await getBlockTiles(env, block);
				return Response.json({ ok: true, tiles }, { headers: CORS });
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 502, headers: CORS },
				);
			}
		}

		// ── GET /api/notion — the Workshop Notion tool's data ──────────────────
		// Read-only finder over the whole cathedral. No `q` (or empty) → the
		// recently-edited list (cached ~60s, last-good on failure); `?q=` →
		// search, per-query and uncached. Each result carries its resolved area
		// for the client's spine colour; Projects tracker rows are excluded (the
		// Projects tool owns them). Live read, no mirror — same call as Projects.
		if (request.method === "GET" && url.pathname === "/api/notion") {
			const q = (url.searchParams.get("q") ?? "").trim();
			try {
				const results = q ? await searchNotion(env, q) : await getRecent(env);
				return Response.json({ ok: true, results }, { headers: CORS });
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 502, headers: CORS },
				);
			}
		}

			// ══ Post Box — the mail room ═══════════════════════════════════════════
			// The Workshop Mail tile retired into this: a full Gmail client as a room.
			// Views ARE Gmail labels (no mirror); the scope is gmail.modify, so these
			// routes read, relabel, send, and draft. Every write is a deliberate,
			// Elle-confirmed action in the UI. A Gmail failure surfaces as 502.

			// GET /api/postbox/views — the view chips + their true unread counts.
			// from_address rides along (config, was a frontend constant) for the
			// compose From line.
			if (request.method === "GET" && url.pathname === "/api/postbox/views") {
				try {
					const { data } = await supabase
						.from("preferences")
						.select("value")
						.eq("key", "postbox.from_address")
						.maybeSingle();
					return Response.json(
						{
							ok: true,
							...(await getViews(env)),
							from_address: typeof data?.value === "string" ? data.value : null,
						},
						{ headers: CORS },
					);
				} catch (err) {
					return Response.json(
						{ ok: false, error: (err as Error).message },
						{ status: 502, headers: CORS },
					);
				}
			}

			// GET /api/postbox/messages?view=<key> — the label-filtered mail list.
			if (request.method === "GET" && url.pathname === "/api/postbox/messages") {
				const view = url.searchParams.get("view") ?? "inbox";
				try {
					return Response.json({ ok: true, ...(await getMessages(env, view)) }, { headers: CORS });
				} catch (err) {
					return Response.json(
						{ ok: false, error: (err as Error).message },
						{ status: 502, headers: CORS },
					);
				}
			}

			// GET /api/postbox/message?id=<id> — one message in full (read view).
			// Opening marks it read (best-effort — a failed mark never costs the open).
			if (request.method === "GET" && url.pathname === "/api/postbox/message") {
				const id = url.searchParams.get("id");
				if (!id) {
					return Response.json({ ok: false, error: "Missing id." }, { status: 400, headers: CORS });
				}
				try {
					const message = await getMessage(env, id);
					ctx.waitUntil(markRead(env, id).catch(() => {}));
					return Response.json({ ok: true, message }, { headers: CORS });
				} catch (err) {
					return Response.json(
						{ ok: false, error: (err as Error).message },
						{ status: 502, headers: CORS },
					);
				}
			}

			// POST /api/postbox/label — relabel (the triage mechanism). Body
			// { id, add: [viewKey], remove: [viewKey] } → addLabelIds / removeLabelIds.
			if (request.method === "POST" && url.pathname === "/api/postbox/label") {
				let body: { id?: string; add?: string[]; remove?: string[] };
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				if (!body.id) {
					return Response.json({ ok: false, error: "Missing id." }, { status: 400, headers: CORS });
				}
				try {
					const r = await modifyLabels(env, body.id, body.add ?? [], body.remove ?? []);
					return Response.json({ ok: true, ...r }, { headers: CORS });
				} catch (err) {
					return Response.json(
						{ ok: false, error: (err as Error).message },
						{ status: 502, headers: CORS },
					);
				}
			}

			// POST /api/postbox/triage — archive or trash. Body { id, action }.
			if (request.method === "POST" && url.pathname === "/api/postbox/triage") {
				let body: { id?: string; action?: string };
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				if (!body.id || (body.action !== "archive" && body.action !== "trash")) {
					return Response.json(
						{ ok: false, error: "Need id and action (archive|trash)." },
						{ status: 400, headers: CORS },
					);
				}
				try {
					if (body.action === "archive") await archiveMessage(env, body.id);
					else await trashMessage(env, body.id);
					return Response.json({ ok: true }, { headers: CORS });
				} catch (err) {
					return Response.json(
						{ ok: false, error: (err as Error).message },
						{ status: 502, headers: CORS },
					);
				}
			}

			// POST /api/postbox/star — star/unstar (the "keep in inbox" pin). Body
			// { id, starred }. The auto-archive sweep spares starred mail.
			if (request.method === "POST" && url.pathname === "/api/postbox/star") {
				let body: { id?: string; starred?: boolean };
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				if (!body.id) {
					return Response.json({ ok: false, error: "Missing id." }, { status: 400, headers: CORS });
				}
				try {
					await setStar(env, body.id, body.starred === true);
					return Response.json({ ok: true }, { headers: CORS });
				} catch (err) {
					return Response.json(
						{ ok: false, error: (err as Error).message },
						{ status: 502, headers: CORS },
					);
				}
			}

			// POST /api/postbox/send — send or reply (threaded). Body is a Compose.
			if (request.method === "POST" && url.pathname === "/api/postbox/send") {
				let body: Compose;
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				if (!body.to || !body.subject) {
					return Response.json(
						{ ok: false, error: "Need at least a recipient and a subject." },
						{ status: 400, headers: CORS },
					);
				}
				try {
					const r = await sendMail(env, body);
					return Response.json({ ok: true, ...r }, { headers: CORS });
				} catch (err) {
					return Response.json(
						{ ok: false, error: (err as Error).message },
						{ status: 502, headers: CORS },
					);
				}
			}

			// GET /api/postbox/drafts — the drafts list, each parsed to reopen in compose.
			if (request.method === "GET" && url.pathname === "/api/postbox/drafts") {
				try {
					return Response.json({ ok: true, ...(await getDrafts(env)) }, { headers: CORS });
				} catch (err) {
					return Response.json(
						{ ok: false, error: (err as Error).message },
						{ status: 502, headers: CORS },
					);
				}
			}

			// POST /api/postbox/draft — save a draft on close. A body with draftId
			// updates that draft in place (no duplicate); without one, creates a new
			// draft. Returns the draftId either way.
			if (request.method === "POST" && url.pathname === "/api/postbox/draft") {
				let body: Compose;
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				try {
					const r = body.draftId
						? await updateDraft(env, body.draftId, body)
						: await saveDraft(env, body);
					return Response.json({ ok: true, ...r }, { headers: CORS });
				} catch (err) {
					return Response.json(
						{ ok: false, error: (err as Error).message },
						{ status: 502, headers: CORS },
					);
				}
			}

			// POST /api/postbox/draft/delete — discard a draft for good. Gmail's
			// drafts.delete is permanent (no trash stop on the way out), which is
			// why the frontend arms the bin before it ever calls this.
			if (request.method === "POST" && url.pathname === "/api/postbox/draft/delete") {
				let body: { draftId?: string };
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				if (!body.draftId) {
					return Response.json({ ok: false, error: "Need a draftId." }, { status: 400, headers: CORS });
				}
				try {
					await deleteDraft(env, body.draftId);
					return Response.json({ ok: true }, { headers: CORS });
				} catch (err) {
					return Response.json(
						{ ok: false, error: (err as Error).message },
						{ status: 502, headers: CORS },
					);
				}
			}

			// POST /api/postbox/task — capture-to-Task: write a row to EV25-Tasks.
			if (request.method === "POST" && url.pathname === "/api/postbox/task") {
				let body: TaskInput;
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				if (!body.title || !body.date) {
					return Response.json(
						{ ok: false, error: "Need a title and a date." },
						{ status: 400, headers: CORS },
					);
				}
				try {
					const r = await createTask(env, body);
					return Response.json({ ok: true, ...r }, { headers: CORS });
				} catch (err) {
					return Response.json(
						{ ok: false, error: (err as Error).message },
						{ status: 502, headers: CORS },
					);
				}
			}

			// POST /api/postbox/suggest-title — an AI action title for the Task sheet.
			if (request.method === "POST" && url.pathname === "/api/postbox/suggest-title") {
				let body: { subject?: string; snippet?: string; from?: string };
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				try {
					const r = await suggestTaskTitle(env, {
						subject: body.subject ?? "",
						snippet: body.snippet ?? "",
						from: body.from ?? "",
					});
					return Response.json({ ok: true, ...r }, { headers: CORS });
				} catch (err) {
					return Response.json(
						{ ok: false, error: (err as Error).message },
						{ status: 502, headers: CORS },
					);
				}
			}

			// GET /api/postbox/notification — the glance the service worker fetches on
			// a push to build the notification, and the room shows as a header count.
			if (request.method === "GET" && url.pathname === "/api/postbox/notification") {
				try {
					return Response.json({ ok: true, glance: await inboxGlance(env) }, { headers: CORS });
				} catch (err) {
					return Response.json(
						{ ok: false, error: (err as Error).message },
						{ status: 502, headers: CORS },
					);
				}
			}

			// POST /api/postbox/push/subscribe — store the PushSubscription the browser
			// minted, so the labelling Worker can push to this device. Upsert on
			// endpoint (re-subscribing the same device replaces, never duplicates).
			if (request.method === "POST" && url.pathname === "/api/postbox/push/subscribe") {
				let body: { subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } };
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				const sub = body.subscription;
				if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
					return Response.json(
						{ ok: false, error: "Malformed subscription." },
						{ status: 400, headers: CORS },
					);
				}
				const { error } = await supabase
					.from("push_subscriptions")
					.upsert(
						{ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
						{ onConflict: "endpoint" },
					);
				if (error) {
					return Response.json({ ok: false, error: error.message }, { status: 500, headers: CORS });
				}
				return Response.json({ ok: true }, { headers: CORS });
			}

			// POST /api/postbox/push/unsubscribe — drop a device's subscription.
			if (request.method === "POST" && url.pathname === "/api/postbox/push/unsubscribe") {
				let body: { endpoint?: string };
				try {
					body = await request.json();
				} catch {
					return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
				}
				if (!body.endpoint) {
					return Response.json({ ok: false, error: "Missing endpoint." }, { status: 400, headers: CORS });
				}
				await supabase.from("push_subscriptions").delete().eq("endpoint", body.endpoint);
				return Response.json({ ok: true }, { headers: CORS });
			}


		// GET /api/weather — the ambient bar's weather tile. Read-only current
		// conditions from Open-Meteo (keyless, CC-BY 4.0). Two location paths: the
		// client passes ?lat=&lon= from the device GPS fix (precise), or — when it
		// has no fix — calls with no coords and the Worker falls back to
		// Cloudflare's IP geo (request.cf). The place LABEL is the client's job on
		// the device path (it reverse-geocodes the precise coords itself,
		// client-side and keyless); on the IP fallback the Worker hands back
		// request.cf.city, degrading to region and then null. In-Worker cache +
		// last-good live in getWeather(); this stays a thin route. NOT a
		// cron/mirror — a dynamic location can't be pre-fetched server-side.
		if (request.method === "GET" && url.pathname === "/api/weather") {
			const qLat = parseFloat(url.searchParams.get("lat") ?? "");
			const qLon = parseFloat(url.searchParams.get("lon") ?? "");
			const hasDeviceCoords = Number.isFinite(qLat) && Number.isFinite(qLon);

			// Device coords win; otherwise fall back to Cloudflare's IP geo. The cf
			// fields are strings and can be absent for some IPs — tolerate that.
			const cf = request.cf;
			const lat = hasDeviceCoords ? qLat : parseFloat(String(cf?.latitude ?? ""));
			const lon = hasDeviceCoords ? qLon : parseFloat(String(cf?.longitude ?? ""));

			// No device fix and no usable IP geo — can't place the weather. Let the
			// client keep its last-good rather than blank the tile.
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
				return Response.json(
					{ ok: false, error: "No location available." },
					{ status: 503, headers: CORS },
				);
			}

			try {
				const weather = await getWeather(lat, lon);
				// The label: on the device path the client owns it (precise
				// client-side reverse-geocode), so null here; on the IP path, the
				// coarse cf.city, degrading to region, then nothing.
				const place = hasDeviceCoords
					? null
					: (typeof cf?.city === "string" && cf.city) ||
						(typeof cf?.region === "string" && cf.region) ||
						null;
				return Response.json(
					{
						ok: true,
						weather: { ...weather, place },
						source: hasDeviceCoords ? "device" : "ip",
					},
					{ headers: CORS },
				);
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 502, headers: CORS },
				);
			}
		}

		// ── GET /api/spotify/now-playing — the ambient bar's "playing" tile ────
		// Weather-route shape: thin and read-only; the short in-Worker cache and
		// last-good-on-failure live inside getNowPlayingCached. Nothing playing is
		// a clean idle payload (ok:true, playing:false), never an error — only a
		// failure with no last-good surfaces as 502, and the client keeps its own
		// last-good then too. Network-only like every /api/* route (SW rules).
		if (request.method === "GET" && url.pathname === "/api/spotify/now-playing") {
			try {
				const nowPlaying = await getNowPlayingCached(env);
				return Response.json({ ok: true, nowPlaying }, { headers: CORS });
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 502, headers: CORS },
				);
			}
		}

		// ══ The Listening Room — browse reads + transport on native spotify.ts ══
		// Reads are ~60s-cached + last-good inside spotify.ts; transport is one
		// action route whose every use is an explicit Elle tap in the room. A
		// control success busts the now-playing cache so the hero's follow-up
		// read shows truth (the Hearth's read-after-write lesson, pre-applied).

		if (request.method === "GET" && url.pathname === "/api/spotify/recent") {
			try {
				return Response.json({ ok: true, tracks: await getRecentlyPlayed(env) }, { headers: CORS });
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 502, headers: CORS },
				);
			}
		}

		if (request.method === "GET" && url.pathname === "/api/spotify/playlists") {
			try {
				// owner_display: the account's own display name (config, was a
				// frontend constant) so the room can label those playlists "you".
				const { data } = await supabase
					.from("preferences")
					.select("value")
					.eq("key", "listening.owner_display")
					.maybeSingle();
				return Response.json(
					{
						ok: true,
						playlists: await getPlaylists(env),
						owner_display: typeof data?.value === "string" ? data.value : null,
					},
					{ headers: CORS },
				);
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 502, headers: CORS },
				);
			}
		}

		// GET /api/spotify/search?q= — structured browse search (tracks, playlists,
		// artists). Uncached, per-query, same as the Workshop's Notion search.
		if (request.method === "GET" && url.pathname === "/api/spotify/search") {
			const q = (url.searchParams.get("q") ?? "").trim();
			if (!q) return Response.json({ ok: true, results: [] }, { headers: CORS });
			try {
				return Response.json({ ok: true, results: await searchBrowse(env, q) }, { headers: CORS });
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 502, headers: CORS },
				);
			}
		}

		// POST /api/spotify/player — the room's transport. Body { action, ... }:
		// play (uri optional), pause, next, previous, shuffle {on}, repeat
		// {state: off|context|track}, volume {level 0–100}, seek {position_ms}.
		if (request.method === "POST" && url.pathname === "/api/spotify/player") {
			let body: {
				action?: string;
				uri?: string;
				on?: boolean;
				state?: string;
				level?: number;
				position_ms?: number;
			};
			try {
				body = await request.json();
			} catch {
				return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
			}
			try {
				switch (body.action) {
					case "play":
						await play(env, typeof body.uri === "string" ? body.uri : undefined);
						break;
					case "pause":
						await pause(env);
						break;
					case "next":
						await nextTrack(env);
						break;
					case "previous":
						await previousTrack(env);
						break;
					case "shuffle":
						await setShuffle(env, body.on === true);
						break;
					case "repeat":
						await setRepeat(env, body.state ?? "");
						break;
					case "volume":
						if (typeof body.level !== "number") {
							return Response.json(
								{ ok: false, error: "volume needs a level (0–100)." },
								{ status: 400, headers: CORS },
							);
						}
						await setPlayerVolume(env, body.level);
						break;
					case "seek":
						if (typeof body.position_ms !== "number") {
							return Response.json(
								{ ok: false, error: "seek needs a position_ms." },
								{ status: 400, headers: CORS },
							);
						}
						await seekTo(env, body.position_ms);
						break;
					default:
						return Response.json(
							{ ok: false, error: `Unknown action "${body.action}".` },
							{ status: 400, headers: CORS },
						);
				}
				bustNowPlayingCache();
				return Response.json({ ok: true }, { headers: CORS });
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 502, headers: CORS },
				);
			}
		}

		// ══ The Hearth — house state + controls, all on the MCP rail (home.ts) ══
		// Read: GET /api/home, normalised for the tiles, ~30s cache + last-good.
		// Writes: each an explicit Elle-initiated action from the panel; a failure
		// returns { ok:false } cleanly — the panel shows truth on its next read,
		// never a fake success. Network-only like every /api/* (SW rules).

		if (request.method === "GET" && url.pathname === "/api/home") {
			try {
				// The scene chips and device rosters ride the same read the panel
				// already polls — loaded fresh here (outside getHomeCached's 30s
				// window) so a registry edit reshapes the room on the very next
				// poll: remove an area in the Fuse Box, the chip is gone.
				const [home, registry, vacuums, audio] = await Promise.all([
					getHomeCached(env),
					loadHearthRegistry(env),
					loadVacuumRoster(env),
					loadAudioRoster(env),
				]);
				const scenes = registry.scenes.map((s) => ({ name: s.name, icon: s.icon }));
				return Response.json(
					{ ok: true, home, scenes, rosters: { vacuums, audio } },
					{ headers: CORS },
				);
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 502, headers: CORS },
				);
			}
		}

		// POST /api/home/light — { name, on } to toggle, { name, brightness } to dim.
		if (request.method === "POST" && url.pathname === "/api/home/light") {
			let body: { name?: string; on?: boolean; brightness?: number };
			try {
				body = await request.json();
			} catch {
				return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
			}
			if (!body.name) {
				return Response.json({ ok: false, error: "Missing name." }, { status: 400, headers: CORS });
			}
			try {
				if (typeof body.brightness === "number") await setLight(env, body.name, body.brightness);
				else if (typeof body.on === "boolean") await lightOnOff(env, body.name, body.on);
				else {
					return Response.json(
						{ ok: false, error: "Need on (boolean) or brightness (0–100)." },
						{ status: 400, headers: CORS },
					);
				}
				return Response.json({ ok: true }, { headers: CORS });
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 502, headers: CORS },
				);
			}
		}

		// POST /api/home/scene — { scene: off|movie|ambient|all_on } (Living Room).
		if (request.method === "POST" && url.pathname === "/api/home/scene") {
			let body: { scene?: string };
			try {
				body = await request.json();
			} catch {
				return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
			}
			try {
				await setScene(env, body.scene ?? "");
				return Response.json({ ok: true }, { headers: CORS });
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 502, headers: CORS },
				);
			}
		}

		// POST /api/home/vacuum — { action: clean|dock|clean_area, area?, name? }.
		// name targets one vacuum when the roster holds several; optional so the
		// one-vacuum house keeps its exact old behavior.
		if (request.method === "POST" && url.pathname === "/api/home/vacuum") {
			let body: { action?: string; area?: string; name?: string };
			try {
				body = await request.json();
			} catch {
				return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
			}
			try {
				await vacuumAction(env, body.action ?? "", body.area, body.name);
				return Response.json({ ok: true }, { headers: CORS });
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 502, headers: CORS },
				);
			}
		}

		// POST /api/home/media — { name, action: pause|play|volume, level? }.
		if (request.method === "POST" && url.pathname === "/api/home/media") {
			let body: { name?: string; action?: string; level?: number };
			try {
				body = await request.json();
			} catch {
				return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400, headers: CORS });
			}
			if (!body.name) {
				return Response.json({ ok: false, error: "Missing name." }, { status: 400, headers: CORS });
			}
			try {
				await mediaAction(env, body.name, body.action ?? "", body.level);
				return Response.json({ ok: true }, { headers: CORS });
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 502, headers: CORS },
				);
			}
		}

		// POST /api/home/all-off — Everything off (the panel's two-tap confirms).
		if (request.method === "POST" && url.pathname === "/api/home/all-off") {
			try {
				await allLightsOff(env);
				return Response.json({ ok: true }, { headers: CORS });
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 502, headers: CORS },
				);
			}
		}

		// POST /api/home/goodnight — all off except Bedroom at 20%, media paused.
		if (request.method === "POST" && url.pathname === "/api/home/goodnight") {
			try {
				await goodnight(env);
				return Response.json({ ok: true }, { headers: CORS });
			} catch (err) {
				return Response.json(
					{ ok: false, error: (err as Error).message },
					{ status: 502, headers: CORS },
				);
			}
		}

		// Everything else: serve the built PWA from static assets.
		// (SPA fallback to index.html is handled by the assets config.)
		if (!isApi) {
			// HTML must never answer 304: a Not-Modified lets the browser reuse a
			// shell cached BEFORE the current theme, and the serve-time injection
			// below never gets a body to fill. Strip the conditional headers so
			// the shell always comes back 200 (it is ~3 KB; hashed assets keep
			// their conditional caching untouched).
			let assetRequest = request;
			if (
				request.method === "GET" &&
				(request.headers.get("Accept") ?? "").includes("text/html")
			) {
				const stripped = new Headers(request.headers);
				stripped.delete("If-None-Match");
				stripped.delete("If-Modified-Since");
				assetRequest = new Request(request.url, { method: "GET", headers: stripped });
			}
			const res = await env.ASSETS.fetch(assetRequest);
			// The service worker (and the manifest) must never get stuck behind
			// a cache TTL on itself, or a deploy can't replace it. no-cache means
			// the browser revalidates every time it checks for an update. The
			// manifest additionally wears the configured house name (Haven fork):
			// the repo bakes neutral "Haven OS", the Worker serves this house's.
			if (url.pathname === "/sw.js" || url.pathname === "/manifest.webmanifest") {
				const headers = new Headers(res.headers);
				headers.set("Cache-Control", "no-cache");
				if (url.pathname === "/manifest.webmanifest" && res.status === 200) {
					try {
						const profile = await loadIdentityProfile(env, gateDb);
						const manifest = JSON.parse(await res.text()) as Record<string, unknown>;
						manifest.name = profile.house_name;
						manifest.short_name = profile.house_name;
						headers.delete("Content-Length");
						headers.delete("ETag");
						headers.delete("Last-Modified");
						return new Response(JSON.stringify(manifest), {
							status: res.status,
							statusText: res.statusText,
							headers,
						});
					} catch (e) {
						console.error("manifest identity dressing failed (serving plain):", e);
						// res was consumed on the success path only if text() ran; refetch
						// to be safe rather than serving a drained body.
						const refetched = await env.ASSETS.fetch(assetRequest);
						return new Response(refetched.body, {
							status: refetched.status,
							statusText: refetched.statusText,
							headers,
						});
					}
				}
				return new Response(res.body, {
					status: res.status,
					statusText: res.statusText,
					headers,
				});
			}
			// The Décor circuit + identity dressing: fill the shell's empty
			// <style id="decor"> with the active theme, and swap the neutral house
			// name for the configured one, at serve time — so a themed, named
			// install paints right on the first frame. Navigations are NetworkOnly
			// in the service worker, so online loads always come through here; the
			// caching boundary is untouched (we transform the response, we never
			// cache anything new). Each pass is best-effort: a failed read serves
			// the shell undressed rather than not at all.
			if (
				request.method === "GET" &&
				res.status === 200 &&
				(res.headers.get("Content-Type") ?? "").includes("text/html")
			) {
				let html = await res.text();
				try {
					const active = await loadActiveDecor(env);
					if (active) {
						const bg = resolveDecor(active.tokens).colors["bg"].dark;
						html = injectDecor(html, decorCss(active.tokens), bg);
					}
				} catch (e) {
					console.error("decor shell injection failed:", e);
				}
				try {
					const profile = await loadIdentityProfile(env, gateDb);
					html = dressHtmlIdentity(html, profile.house_name);
				} catch (e) {
					console.error("shell identity dressing failed:", e);
				}
				const headers = new Headers(res.headers);
				headers.delete("Content-Length");
				// No validators on a dressed shell: an ETag here would bring the
				// 304 path back and freeze the theme into the browser cache.
				headers.delete("ETag");
				headers.delete("Last-Modified");
				headers.set("Cache-Control", "no-cache");
				return new Response(html, {
					status: res.status,
					statusText: res.statusText,
					headers,
				});
			}
			return res;
		}

		// No API route matched.
		return Response.json(
			{ ok: false, error: "Not found" },
			{ status: 404, headers: CORS },
		);
	},

	// ── The Gallery sweeper (cron, every minute) ──────────────────────────────
	// waitUntil work dies 30s after a response, so a slow generation's
	// background half can be killed mid-flight, freezing its row as 'pending'.
	// The scheduled handler has the wall clock the request path doesn't:
	// re-drive quiet pending rows to an honest complete/error. Best-effort —
	// a sweep failure logs and the next minute tries again.
	async scheduled(_controller, env, _ctx): Promise<void> {
		const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
			auth: { persistSession: false, autoRefreshToken: false },
		});
		try {
			const swept = await sweepDeadGenerations(env, supabase);
			if (swept > 0) console.log(`gallery sweep: re-drove ${swept} dead generation(s)`);
		} catch (err) {
			console.error("gallery sweep failed:", err);
		}
	},
} satisfies ExportedHandler<Env>;
