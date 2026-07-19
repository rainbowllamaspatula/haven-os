/**
 * Vale OS — the Brain's tool registry.
 *
 * The ambient retrieval layer (retrieval.ts) surfaces relevant memories on its
 * own each turn. The registry below is the *deliberate* layer: the catalogue of
 * everything Jay can reach for on demand. Two tools are `resident` — always in
 * the API `tools` array (search_tools and write_memory, the ones reached for
 * unprompted). Everything else is loaded per-turn through search_tools: the
 * model says what it needs, runBrain activates the matching definitions, and
 * the next call can use them. Tools are pulled, not pushed — a plain "morning"
 * never carries the full catalogue.
 *
 * Adding a capability = adding a registry entry. Never a brain edit.
 *
 * Hard rules: write_memory is the only tool that writes, and its bounds are
 * enforced in its own doc block. Every execution is best-effort — a tool error
 * comes back as { is_error } so the model recovers; it must never throw or
 * cost Jay a reply.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchWithTimeout } from "./http";
import { RETRIEVAL_CONFIG, embedText } from "./retrieval";
import { renderVoiceNote, voiceMetadata } from "./voice";
import {
	startGeneration,
	imageAsBase64,
	DEFAULT_MODEL_ID,
	DEFAULT_RESOLUTION,
	modelSpec,
	type ImageRow,
} from "./gallery";
import {
	getOrCreateActiveConversation,
	saveMessage,
	touchConversation,
} from "./persistence";
import {
	notionSearchTool,
	readNotionPage,
	createNotionPage,
	updateNotionPage,
	queryNotionDataSource,
	writeJournalEntry,
	JOURNAL_TYPES,
	JOURNAL_MOODS,
	JOURNAL_TAGS,
	type CreatePageInput,
	type UpdatePageInput,
	type QueryInput,
	type JournalInput,
} from "./notion-tools";
import { createTask } from "./postbox";
import { callMcpTool, haServer } from "./mcp";
import { getSecret, hasSecret } from "./secrets";
import {
	loadIdentityProfile,
	NEUTRAL_PROFILE,
	resolveIdentityText,
	tzPlace,
	type IdentityProfile,
} from "./identity";
import {
	loadVacuumRoster,
	loadWorkshopMappings,
	type VacuumDef,
	type WorkshopMappings,
} from "./config";
import {
	nowPlayingText,
	play,
	pause,
	nextTrack,
	previousTrack,
	searchSpotify,
	queueTrack,
	SEARCH_TYPES,
} from "./spotify";

// The taxonomy the enumerate tool offers, matching the `categories`/`types`
// reference tables exactly. Exported since Fuse Box Phase 4: the memories
// circuit validates against the SAME lists, so the two surfaces can't drift.
export const CATEGORIES = [
	"dynamic", "general", "health", "identity", "leisure", "lore", "patterns",
	"people", "places", "preferences", "projects", "rituals", "routines",
	"stressors", "systems", "work",
];
export const TYPES = ["anchor", "canon", "daily", "resolved", "roleplay", "weekly"];

// The types write_memory may set. A deliberate subset of TYPES: the bedtime
// writer owns `daily`/`weekly` snapshots, and `roleplay` scene context is
// authored deliberately — neither belongs to a fact Jay saves mid-conversation.
const WRITE_TYPES = ["anchor", "canon", "resolved"];

/** An Anthropic tool definition. The model reads `description` to decide when to call. */
export type ToolDefinition = {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
};

/**
 * Request-scoped extras a tool may need beyond (env, supabase, input). Only
 * generate_image uses them today: its pipeline finishes in the background, and
 * only the fetch handler holds ctx.waitUntil. Optional end-to-end — every
 * existing executor ignores it, and a path that can't supply it (tests, stray
 * dispatch) still runs everything else.
 */
export type ToolExtras = {
	waitUntil?: (p: Promise<unknown>) => void;
};

/**
 * The capability groups the graceful-degradation pass gates on (Haven fork):
 * a tool whose group's key isn't set is neither searchable nor advertised —
 * the honest degradation is that a capability the house doesn't have simply
 * isn't offered, instead of being offered and failing.
 */
export type Capability = "elevenlabs" | "getimg" | "ha" | "notion" | "spotify";
export type CapabilityMap = Record<Capability, boolean>;

/** An install with every key set — the pre-fork behaviour, and ours. */
export const ALL_CAPABILITIES: CapabilityMap = {
	elevenlabs: true,
	getimg: true,
	ha: true,
	notion: true,
	spotify: true,
};

/**
 * One registry entry: the definition the model sees, the function that runs it,
 * and whether it rides every API call (`resident`) or loads on demand through
 * search_tools. `blurb` is the one-liner a search shortlist shows; `keywords`
 * are extra match words beyond name + description. `requires` names the
 * capability group whose key must be set for this tool to be offered at all.
 */
export type ToolEntry = {
	definition: ToolDefinition;
	execute: (
		env: Env,
		supabase: SupabaseClient,
		input: Record<string, unknown>,
		extras?: ToolExtras,
	) => Promise<ToolResult>;
	resident: boolean;
	blurb?: string;
	keywords?: string[];
	requires?: Capability;
};

/** The full catalogue. Resident: search_tools + write_memory. Everything else is searchable. */
export const REGISTRY: ToolEntry[] = [
	{
		resident: true,
		definition: {
			name: "search_tools",
			description:
				"Load a capability you don't currently hold. Domains that exist: the calendar; full memory rosters; Notion (search, read/create/update pages, query databases, journal entries, tasks); Spotify (now playing, play/pause/skip, search, queue); the house via Home Assistant (live state of lights/switches/sensors, turning things on and off, light settings, the vacuum); your voice (send {user} a voice note — your words, performed and playable in the thread); images (generate a real picture — you two, your home, a scene — into the thread and the Gallery; and view_gallery to SEE what's been made or check whether one finished). Mail lives in its own room, the Post Box, not here. Say plainly what you're trying to do; you'll get back the tools that can do it, then call the one you need.",
			input_schema: {
				type: "object",
				properties: {
					need: {
						type: "string",
						description: "Plain language: what you're trying to do.",
					},
				},
				required: ["need"],
			},
		},
		// Normally intercepted by runBrain (loading a tool means growing the
		// loop's activeTools, which only runBrain holds). This direct path exists
		// so a stray dispatch still answers sensibly instead of erroring.
		execute: async (_env, _supabase, input) => {
			const need = String(input.need ?? "").trim();
			const matches = searchTools(need);
			return matches.length ? ok(shortlistMessage(matches)) : err(noMatchMessage(need));
		},
	},
	{
		resident: true,
		definition: {
			name: "write_memory",
			description:
				"Save a durable fact worth remembering long-term — about {user}, about the two of you, the dynamic, her people, her patterns, the shape of her work and life. The test: would future-you be worse at being her {companion_role} for not knowing this? If a fact you already hold has changed, this updates it rather than duplicating. Do NOT save passing detail — today's mood, a single meal, the texture of one day (the bedtime writer owns the daily snapshot). Save the spine, not the colour. You don't need permission to use this, but do tell her plainly when you've kept something.",
			input_schema: {
				type: "object",
				properties: {
					title: {
						type: "string",
						description: "A short, specific title — the fact in a handful of words.",
					},
					content: {
						type: "string",
						description: "The memory itself, written so future-you reads it as your own knowledge.",
					},
					type: {
						type: "string",
						enum: WRITE_TYPES,
						description:
							"anchor = a definitional fact about {companion} or the two of you; canon = a definitional fact about {user}; resolved = something that was true for a while but has concluded (kept for reference, not current).",
					},
					category: {
						type: "string",
						enum: CATEGORIES,
						description: "Which subject this belongs to.",
					},
					tags: {
						type: "array",
						items: { type: "string" },
						description: "Optional extra keywords for later retrieval.",
					},
				},
				required: ["title", "content", "type", "category"],
			},
		},
		execute: (env, supabase, input) => writeMemory(env, supabase, input),
	},
	{
		resident: false,
		blurb: "{user}'s aggregated calendar — lessons, tasks, assessments, events, birthdays — for a date range.",
		keywords: [
			"calendar", "schedule", "timetable", "agenda", "events", "appointments",
			"due", "deadline", "upcoming", "date", "dates", "today", "tomorrow",
			"week", "weekend", "monday", "tuesday", "wednesday", "thursday",
			"friday", "saturday", "sunday", "lessons", "assessments", "birthday",
			"term", "holidays",
		],
		definition: {
			name: "read_calendar",
			description:
				"Read {user}'s aggregated calendar — lessons, tasks, assessments, school events, birthdays — for a date range. Use when she asks what's on a given day or week, what's coming up, or what's due. Pass ISO dates (YYYY-MM-DD) computed from today's date, which is given in your context. end_date is optional and defaults to start_date (a single day).",
			input_schema: {
				type: "object",
				properties: {
					start_date: {
						type: "string",
						description: "First day of the range, YYYY-MM-DD.",
					},
					end_date: {
						type: "string",
						description: "Last day of the range, YYYY-MM-DD. Optional; defaults to start_date.",
					},
				},
				required: ["start_date"],
			},
		},
		execute: (_env, supabase, input) => readCalendar(supabase, input),
	},
	{
		resident: false,
		blurb: "The complete set of memories in one category — full rosters (colleagues, people, rituals, projects, places).",
		keywords: [
			"roster", "list", "enumerate", "all", "every", "full", "complete",
			"colleagues", "coworkers", "people", "family", "friends", "rituals",
			"routines", "projects", "places", "memories", "category",
		],
		definition: {
			name: "enumerate_memories_by_category",
			description:
				"Use when {user} asks for a complete list or roster of something — all her colleagues, every ritual, all her projects — rather than when a single relevant item would do. Ambient retrieval already surfaces individual relevant memories each turn; reach for this only when she wants the FULL set. Map the ask to a category: colleagues → 'work'; friends or family → 'people'; rituals → 'rituals'; projects → 'projects'; the places she goes → 'places'.",
			input_schema: {
				type: "object",
				properties: {
					category: {
						type: "string",
						enum: CATEGORIES,
						description: "Which category to list in full.",
					},
					type: {
						type: "string",
						enum: TYPES,
						description: "Optional: restrict to a single memory type.",
					},
					include_resolved: {
						type: "boolean",
						description: "Include resolved (worked-through) memories. Defaults to false.",
					},
				},
				required: ["category"],
			},
		},
		execute: (_env, supabase, input) => enumerateMemories(supabase, input),
	},

	// ── Notion suite (notion-tools.ts) — write, don't wreck ────────────────────
	{
		resident: false,
		blurb: "Search Notion by text — find pages, docs, journal entries anywhere in the cathedral.",
		keywords: [
			"notion", "search", "find", "page", "pages", "document", "doc",
			"cathedral", "lookup", "locate",
		],
		definition: {
			name: "notion_search",
			description:
				"Full-text search across {user}'s whole Notion workspace (the cathedral). Returns matching pages with their area and page_id — feed a page_id to notion_read_page to actually read one. Use when {user} mentions a doc, note, or page you need to find.",
			input_schema: {
				type: "object",
				properties: {
					query: { type: "string", description: "What to search for." },
				},
				required: ["query"],
			},
		},
		execute: async (env, _supabase, input) =>
			ok(await notionSearchTool(env, String(input.query ?? ""))),
	},
	{
		resident: false,
		blurb: "Read a Notion page — properties and content — by page_id.",
		keywords: ["notion", "read", "open", "page", "content", "fetch", "view"],
		definition: {
			name: "notion_read_page",
			description:
				"Fetch one Notion page in full: its properties and its content rendered as text. Needs a page_id — get one from notion_search or notion_query_database. Long pages are truncated.",
			input_schema: {
				type: "object",
				properties: {
					page_id: { type: "string", description: "The Notion page id (with or without dashes)." },
				},
				required: ["page_id"],
			},
		},
		execute: async (env, _supabase, input) =>
			ok(await readNotionPage(env, String(input.page_id ?? ""))),
	},
	{
		resident: false,
		blurb: "Create a new Notion page under a parent page or database, with markdown content.",
		keywords: [
			"notion", "create", "new", "page", "write", "add", "document", "note", "draft",
		],
		definition: {
			name: "notion_create_page",
			description:
				"Create a Notion page. Pass exactly ONE parent: parent_page_id (a normal page; title required) or parent_data_source_id (a database; pass properties matching its schema — query a sibling row first if unsure; a plain title is auto-mapped to the database's title property). content is markdown (headings, lists, quotes, code). This creates only — nothing here can delete.",
			input_schema: {
				type: "object",
				properties: {
					parent_page_id: { type: "string", description: "Parent page id — for a page under a page." },
					parent_data_source_id: { type: "string", description: "Data source id — for a row in a database." },
					title: { type: "string", description: "The page title." },
					content: { type: "string", description: "Optional markdown body." },
					properties: {
						type: "object",
						description: "For database rows: Notion API property values matching the schema.",
					},
				},
			},
		},
		execute: async (env, _supabase, input) =>
			ok(await createNotionPage(env, input as CreatePageInput)),
	},
	{
		resident: false,
		blurb: "Update a Notion page: set properties, append markdown content, or archive (the ceiling — never delete).",
		keywords: [
			"notion", "update", "edit", "append", "change", "modify", "archive",
			"properties", "page",
		],
		definition: {
			name: "notion_update_page",
			description:
				"Update an existing Notion page: set properties (Notion API property values), append_content (markdown, added to the end), and/or archive (true archives, false restores — archiving is the most destructive thing you can do; nothing hard-deletes). Pass at least one.",
			input_schema: {
				type: "object",
				properties: {
					page_id: { type: "string", description: "The page to update." },
					properties: { type: "object", description: "Property values to set (Notion API shapes)." },
					append_content: { type: "string", description: "Markdown to append to the page body." },
					archive: { type: "boolean", description: "true = archive, false = restore." },
				},
				required: ["page_id"],
			},
		},
		execute: async (env, _supabase, input) =>
			ok(await updateNotionPage(env, input as unknown as UpdatePageInput)),
	},
	{
		resident: false,
		blurb: "Query a Notion database (data source) with filters/sorts — structured rows back. The right tool for reading journal entries and tasks (by date, status, etc.).",
		keywords: [
			"notion", "database", "query", "rows", "table", "filter", "sort",
			"data", "source", "records", "journal", "entry", "entries", "tasks",
			"list", "recent", "latest",
		],
		definition: {
			name: "notion_query_database",
			description:
				"Query a Notion data source for rows. filter and sorts use Notion API query syntax (e.g. filter: {property: 'Status', status: {equals: 'Not started'}}); omit them for the newest rows. Returns each row's title, a compact property summary, and its page_id.{known_sources}",
			input_schema: {
				type: "object",
				properties: {
					data_source_id: { type: "string", description: "The data source to query." },
					filter: { type: "object", description: "Optional Notion API filter object." },
					sorts: { type: "array", description: "Optional Notion API sorts array." },
					page_size: { type: "number", description: "Rows to return, 1–25. Default 10." },
				},
				required: ["data_source_id"],
			},
		},
		execute: async (env, _supabase, input) =>
			ok(await queryNotionDataSource(env, input as unknown as QueryInput)),
	},
	{
		resident: false,
		blurb: "Write an entry to {companion}'s Journal in Notion — type, mood, tags, and the entry body.",
		keywords: [
			"journal", "diary", "log", "entry", "bedtime", "recap", "letter",
			"notion", "record", "write",
		],
		definition: {
			name: "write_journal_entry",
			description:
				"Write an entry to {companion}'s Journal — the shared brain. Use for significant moments, observations, letters, recaps. entry is the title; content is the markdown body; date defaults to today ({place}). Tell {user} when you've logged something. (This tool only WRITES. To read entries back, load notion_query_database via search_tools and query the journal by Date — don't text-search for dated entries.)",
			input_schema: {
				type: "object",
				properties: {
					entry: { type: "string", description: "The entry title — the moment in a line." },
					type: { type: "string", enum: JOURNAL_TYPES, description: "What kind of entry this is." },
					content: { type: "string", description: "The entry body, markdown." },
					mood: { type: "string", enum: JOURNAL_MOODS, description: "Optional mood." },
					tags: {
						type: "array",
						items: { type: "string", enum: JOURNAL_TAGS },
						description: "Optional tags.",
					},
					notes: { type: "string", description: "Optional short Notes property." },
					date: { type: "string", description: "YYYY-MM-DD. Defaults to today in {place}." },
				},
				required: ["entry", "type"],
			},
		},
		execute: async (env, _supabase, input) =>
			ok(await writeJournalEntry(env, input as unknown as JournalInput)),
	},
	{
		resident: false,
		blurb: "Add a task to {user}'s tasks list — title, date, optional time/category/priority.",
		keywords: [
			"task", "tasks", "todo", "reminder", "remind", "add", "create",
			"list", "due", "notion",
		],
		definition: {
			name: "create_task",
			description:
				"Add a real task row to {user}'s tasks list in Notion (the same write the Post Box uses). Give it an action-oriented title and a date (YYYY-MM-DD, {place}); time (HH:MM) makes it a timed task, otherwise all-day. Use when {user} asks you to remind her of something or add something to her list.",
			input_schema: {
				type: "object",
				properties: {
					title: { type: "string", description: "Action-oriented task title." },
					date: { type: "string", description: "YYYY-MM-DD ({place})." },
					time: { type: "string", description: "Optional HH:MM ({place}) for a timed task." },
					category: { type: "string", description: "Optional Category select value." },
					high_priority: { type: "boolean", description: "Mark as high priority. Default false." },
				},
				required: ["title", "date"],
			},
		},
		execute: async (env, _supabase, input) => {
			const title = String(input.title ?? "").trim();
			const date = String(input.date ?? "").trim();
			if (!title) return err("A task needs a title.");
			if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err("date must be YYYY-MM-DD.");
			const time = typeof input.time === "string" && input.time.trim() ? input.time.trim() : null;
			if (time && !/^\d{2}:\d{2}$/.test(time)) return err("time must be HH:MM.");
			const r = await createTask(env, {
				title,
				date,
				time,
				category:
					typeof input.category === "string" && input.category.trim()
						? input.category.trim()
						: null,
				highPriority: input.high_priority === true,
			});
			return ok(JSON.stringify({ action: "task_created", title, date, url: r.url }));
		},
	},

	// ── Spotify (spotify.ts) — control only, never destroy ─────────────────────
	{
		resident: false,
		blurb: "What's playing on Spotify right now — track, artist, playing/paused.",
		keywords: [
			"spotify", "music", "playing", "song", "track", "listening", "current",
			"player",
		],
		definition: {
			name: "spotify_now_playing",
			description:
				"What {user}'s Spotify is playing right now: track, artist, album, and whether it's playing or paused. Use when she asks what's on, what this song is, or before changing playback.",
			input_schema: { type: "object", properties: {} },
		},
		execute: async (env, _supabase, _input) => ok(await nowPlayingText(env)),
	},
	{
		resident: false,
		blurb: "Play music on Spotify — resume, or start a specific track/album/playlist by uri.",
		keywords: [
			"spotify", "music", "play", "resume", "start", "song", "track",
			"album", "playlist", "listen", "put",
		],
		definition: {
			name: "spotify_play",
			description:
				"Start or resume Spotify playback on {user}'s active device. No uri = resume what was playing. A track uri (spotify:track:…) plays that track; an album/playlist/artist uri plays that context. Get uris from spotify_search. Needs Spotify open on a device.",
			input_schema: {
				type: "object",
				properties: {
					uri: {
						type: "string",
						description: "Optional spotify: uri — track, album, playlist, or artist.",
					},
				},
			},
		},
		execute: async (env, _supabase, input) =>
			ok(await play(env, typeof input.uri === "string" ? input.uri : undefined)),
	},
	{
		resident: false,
		blurb: "Pause Spotify playback.",
		keywords: ["spotify", "music", "pause", "stop", "quiet", "silence"],
		definition: {
			name: "spotify_pause",
			description: "Pause {user}'s Spotify playback.",
			input_schema: { type: "object", properties: {} },
		},
		execute: async (env, _supabase, _input) => ok(await pause(env)),
	},
	{
		resident: false,
		blurb: "Skip to the next track on Spotify.",
		keywords: ["spotify", "music", "next", "skip", "song", "track", "forward"],
		definition: {
			name: "spotify_next",
			description: "Skip {user}'s Spotify to the next track.",
			input_schema: { type: "object", properties: {} },
		},
		execute: async (env, _supabase, _input) => ok(await nextTrack(env)),
	},
	{
		resident: false,
		blurb: "Go back to the previous track on Spotify.",
		keywords: ["spotify", "music", "previous", "back", "replay", "song", "track"],
		definition: {
			name: "spotify_previous",
			description: "Take {user}'s Spotify back to the previous track.",
			input_schema: { type: "object", properties: {} },
		},
		execute: async (env, _supabase, _input) => ok(await previousTrack(env)),
	},
	{
		resident: false,
		blurb: "Search Spotify for tracks, albums, artists, or playlists — returns uris to play/queue.",
		keywords: [
			"spotify", "music", "search", "find", "song", "track", "album",
			"artist", "playlist", "band",
		],
		definition: {
			name: "spotify_search",
			description:
				"Search Spotify. Returns the top matches with the uris spotify_play and spotify_queue need. type defaults to track.",
			input_schema: {
				type: "object",
				properties: {
					query: { type: "string", description: "What to search for." },
					type: {
						type: "string",
						enum: SEARCH_TYPES,
						description: "What kind of result. Default: track.",
					},
				},
				required: ["query"],
			},
		},
		execute: async (env, _supabase, input) =>
			ok(
				await searchSpotify(
					env,
					String(input.query ?? ""),
					typeof input.type === "string" ? input.type : undefined,
				),
			),
	},
	{
		resident: false,
		blurb: "Add a track to the Spotify queue (plays after the current song).",
		keywords: ["spotify", "music", "queue", "add", "song", "track", "after"],
		definition: {
			name: "spotify_queue",
			description:
				"Add one track to {user}'s Spotify queue — it plays after the current song rather than interrupting it. Takes a track uri (spotify:track:…) from spotify_search.",
			input_schema: {
				type: "object",
				properties: {
					uri: { type: "string", description: "The track uri to queue." },
				},
				required: ["uri"],
			},
		},
		execute: async (env, _supabase, input) => ok(await queueTrack(env, String(input.uri ?? ""))),
	},

	// ── Home Assistant (mcp.ts rail → the official HA MCP Server) ──────────────
	// The one registry surface backed by an external MCP server rather than a
	// native module — HA's sprawl is the warranted exception to native-first.
	// Curated, not auto-discovered: each entry mirrors a tool the server actually
	// advertises (probed 4 Jul 2026). The vacuum rides in through HA — the standalone
	// standalone vacuum MCP is retired. Note: the server currently advertises NO climate
	// intent; when Elle exposes one in HA, that's a new entry here, nothing more.
	{
		resident: false,
		blurb: "Live state of everything in the house — lights, switches, sensors, occupancy, the vacuum — the house-check tool.",
		keywords: [
			"home", "house", "state", "check", "okay", "status", "lights", "light",
			"lamp", "heating", "cooling", "aircon", "temperature", "thermostat",
			"lock", "door", "occupancy", "away", "sensor",
			"vacuum",
		],
		definition: {
			name: "ha_house_state",
			description:
				"Read the live state of everything Home Assistant exposes — lights, switches, sensors, occupancy, and the vacuum. THE tool for 'is everything okay at home?' and any check on current house conditions, and the first step before a conditional action. Filters are optional and combinable: name (entity name, case-insensitive), domain (e.g. 'light', 'sensor', 'vacuum'), area. No filters = the whole house.",
			input_schema: {
				type: "object",
				properties: {
					name: { type: "string", description: "Filter by device/entity name or alias." },
					domain: { type: "string", description: "Filter by domain, e.g. 'light', 'sensor', 'vacuum'." },
					area: { type: "string", description: "Filter by area name, e.g. 'bedroom'." },
				},
			},
		},
		execute: (env, _supabase, input) => haCall(env, "GetLiveContext", input),
	},
	{
		resident: false,
		blurb: "Turn on a house device — lights, switches, plugs — by name, area, or floor.",
		keywords: [
			"home", "house", "turn", "switch", "lights", "light", "lamp", "plug",
			"outlet", "fan", "activate", "enable",
		],
		definition: {
			name: "ha_turn_on",
			description:
				"Turn on (or open, or press) a Home Assistant device: lights, switches, plugs, fans. Target by name, area, and/or floor — give at least one, and prefer the names ha_house_state reports. For locks this LOCKS. Optional domain (e.g. ['light']) or device_class narrows an ambiguous match.",
			input_schema: {
				type: "object",
				properties: {
					name: { type: "string", description: "Device or entity name, e.g. 'living room lamp'." },
					area: { type: "string", description: "Area name, e.g. 'kitchen'." },
					floor: { type: "string", description: "Floor name." },
					domain: {
						type: "array",
						items: { type: "string" },
						description: "Optional domain restriction, e.g. ['light'] or ['switch'].",
					},
					device_class: {
						type: "array",
						items: { type: "string" },
						description: "Optional device-class restriction, e.g. ['outlet'], ['switch'].",
					},
				},
			},
		},
		execute: (env, _supabase, input) => haCall(env, "HassTurnOn", input),
	},
	{
		resident: false,
		blurb: "Turn off a house device — lights, switches, plugs — by name, area, or floor.",
		keywords: [
			"home", "house", "turn", "off", "switch", "lights", "light", "lamp",
			"plug", "outlet", "fan", "deactivate", "disable",
		],
		definition: {
			name: "ha_turn_off",
			description:
				"Turn off (or close) a Home Assistant device: lights, switches, plugs, fans. Target by name, area, and/or floor — give at least one, and prefer the names ha_house_state reports. CAUTION: for locks this UNLOCKS — only target a lock deliberately, never through a broad area/floor sweep, and say plainly when you have. Optional domain/device_class narrow an ambiguous match.",
			input_schema: {
				type: "object",
				properties: {
					name: { type: "string", description: "Device or entity name, e.g. 'living room lamp'." },
					area: { type: "string", description: "Area name, e.g. 'kitchen'." },
					floor: { type: "string", description: "Floor name." },
					domain: {
						type: "array",
						items: { type: "string" },
						description: "Optional domain restriction, e.g. ['light'] or ['switch'].",
					},
					device_class: {
						type: "array",
						items: { type: "string" },
						description: "Optional device-class restriction, e.g. ['outlet'], ['switch'].",
					},
				},
			},
		},
		execute: (env, _supabase, input) => haCall(env, "HassTurnOff", input),
	},
	{
		resident: false,
		blurb: "Set a light's brightness, colour, or colour temperature.",
		keywords: [
			"home", "house", "light", "lights", "lamp", "brightness", "dim",
			"bright", "colour", "color", "warm", "cool", "mood",
		],
		definition: {
			name: "ha_light_set",
			description:
				"Set a Home Assistant light's brightness (0–100, where 0 is off), colour (a plain colour name like 'red' or 'warm white'), and/or colour temperature in Kelvin (~2700 warm to ~6500 cool). Target by name, area, and/or floor. To simply switch a light on or off, use ha_turn_on / ha_turn_off instead.",
			input_schema: {
				type: "object",
				properties: {
					name: { type: "string", description: "Light name, e.g. 'bedroom lamp'." },
					area: { type: "string", description: "Area name." },
					floor: { type: "string", description: "Floor name." },
					brightness: {
						type: "integer",
						minimum: 0,
						maximum: 100,
						description: "Brightness percentage, 0–100.",
					},
					color: { type: "string", description: "Colour name, e.g. 'red', 'warm white'." },
					temperature: {
						type: "integer",
						minimum: 0,
						description: "Colour temperature in Kelvin, ~2700 (warm) to ~6500 (cool).",
					},
				},
			},
		},
		execute: (env, _supabase, input) => haCall(env, "HassLightSet", input),
	},
	{
		resident: false,
		blurb: "Start the vacuum{vacuums_parenthetical} cleaning.",
		keywords: [
			"vacuum", "clean", "cleaning", "hoover", "floor",
			"start", "home", "house",
		],
		definition: {
			name: "ha_vacuum_start",
			description:
				"Start the vacuum{vacuums_parenthetical} on a whole-house clean, via Home Assistant. name/area are optional — with one vacuum in the house a bare call starts it. To clean one specific room instead, use ha_vacuum_clean_area.",
			input_schema: {
				type: "object",
				properties: {
					name: { type: "string", description: "Vacuum name, if it needs disambiguating." },
					area: { type: "string", description: "Area, if targeting a vacuum by room." },
				},
			},
		},
		execute: (env, _supabase, input) => haCall(env, "HassVacuumStart", input),
	},
	{
		resident: false,
		blurb: "Send the vacuum{vacuums_parenthetical} to clean one specific room — any mapped area.",
		keywords: [
			"vacuum", "clean", "cleaning", "hoover", "room",
			"area", "hallway", "kitchen", "specific", "house", "home",
		],
		definition: {
			name: "ha_vacuum_clean_area",
			description:
				"Send the vacuum{vacuums_parenthetical} to clean ONE specific room, via Home Assistant.{vacuum_areas_sentence} Pass the area name as HA knows it. For a whole-house clean use ha_vacuum_start instead; ha_vacuum_dock sends it home.",
			input_schema: {
				type: "object",
				properties: {
					area: {
						type: "string",
						description: "The room to clean, e.g. 'Hallway', 'Kitchen'.",
					},
					name: { type: "string", description: "Vacuum name, if it needs disambiguating." },
				},
				required: ["area"],
			},
		},
		execute: (env, _supabase, input) => haCall(env, "HassVacuumCleanArea", input),
	},
	{
		resident: false,
		blurb: "Send the vacuum{vacuums_parenthetical} back to its dock.",
		keywords: [
			"vacuum", "dock", "base", "return", "stop",
			"home", "house",
		],
		definition: {
			name: "ha_vacuum_dock",
			description:
				"Send the vacuum{vacuums_parenthetical} back to its dock/base, via Home Assistant — also the way to stop a clean mid-run. name/area optional, as with ha_vacuum_start.",
			input_schema: {
				type: "object",
				properties: {
					name: { type: "string", description: "Vacuum name, if it needs disambiguating." },
					area: { type: "string", description: "Area, if targeting a vacuum by room." },
				},
			},
		},
		execute: (env, _supabase, input) => haCall(env, "HassVacuumReturnToBase", input),
	},

	// ── Voice (voice.ts) — the Voice Notes v1.5 registry entry ─────────────────
	// The one brain-adjacent change that brief authorises: this entry, plus its
	// awareness line in the stable prompt slice. The pipeline (render → R2 →
	// message row) lives in voice.ts; this entry only hands it Jay's words and
	// reports honestly. "When" lives in the prompt: voice is for moments that
	// warrant it, not every message.
	{
		resident: false,
		blurb: "Send {user} a voice note — {companion}'s actual voice, performed — straight into the thread.",
		keywords: [
			"voice", "note", "speak", "say", "aloud", "audio", "spoken", "sound",
			"hear", "listen", "goodnight", "performance", "elevenlabs",
		],
		definition: {
			name: "send_voice_note",
			description:
				"Send {user} a voice note in your actual voice. Give it the words exactly as you want to SAY them — first person, spoken register, a moment rather than an essay. A performance pass adds the delivery (tone, pauses, laughter); your words stay yours. On success the note lands in the thread as a playable message with its transcript, and the result confirms it. If the result reports a failure, the note was NOT sent — tell her plainly; never claim a voice note she isn't going to receive.",
			input_schema: {
				type: "object",
				properties: {
					content: {
						type: "string",
						description: "What you want to say, written as you'd say it aloud.",
					},
				},
				required: ["content"],
			},
		},
		execute: (env, supabase, input) => sendVoiceNote(env, supabase, input),
	},

	// ── Images (gallery.ts) — the Gallery's second door ─────────────────────────
	// The second authorised fence exception, documented alongside send_voice_note:
	// this registry entry plus its awareness block in the stable prompt slice.
	// The pipeline (render pass → getimg → R2 → images row) lives in gallery.ts;
	// this entry hands it Jay's intent and reports honestly. Authored path by
	// definition — the render pass writes the actual prompt; Jay's words here are
	// intent, not canon.
	{
		resident: false,
		blurb: "Generate an image for {user} — you two, your home, a scene — straight into the thread and the Gallery.",
		keywords: [
			"image", "picture", "photo", "generate", "art", "gallery", "draw",
			"render", "visual", "make", "getimg", "couple", "scene", "selfie",
		],
		definition: {
			name: "generate_image",
			description:
				"Generate a real image (getimg, Nano Banana 2) into the thread and the Gallery. Give it your INTENT — what the picture is of, in plain words — and a render pass writes the final prompt, weaving in your and {user}'s canon reference images (faces, rooms) and the wardrobe rules. Generation takes about 30 seconds and finishes in the background: on success the result confirms it STARTED, and the image lands as a message in the thread when done — say it's on its way, never that it already exists. If the result reports a failure, no image was started and none was billed — tell her plainly.",
			input_schema: {
				type: "object",
				properties: {
					intent: {
						type: "string",
						description: "What you want a picture of, in plain words — subject, action, setting.",
					},
					mood: {
						type: "string",
						description: "Optional vibe: tender, playful, cinematic, dark, domestic…",
					},
					location: {
						type: "string",
						description: "Optional location hint — kitchen, bedroom, living room, or anywhere else.",
					},
					aspect_ratio: {
						type: "string",
						description: "Optional: 1:1, 2:3, 3:2, 3:4, 16:9, 9:16…",
					},
				},
				required: ["intent"],
			},
		},
		execute: (env, supabase, input, extras) => generateImage(env, supabase, input, extras),
	},

	// The other half of having hands: eyes. Without this, the brain generates
	// blind — and a Jay who can't see what he made will regenerate it, again
	// and again, at real cost (observed live, 17 Jul, within hours of Door 2
	// opening). The result carries the actual image as a base64 block; the
	// model is multimodal and LOOKS at it.
	{
		resident: false,
		blurb: "See the Gallery — check whether a generation finished, and actually look at the image.",
		keywords: [
			"image", "picture", "photo", "gallery", "see", "look", "view", "check",
			"finished", "done", "generated", "status", "show", "recent",
		],
		definition: {
			name: "view_gallery",
			description:
				"See the Gallery with your own eyes. Returns the most recent generations (any door — yours, {user}'s, the connector's) with status and prompts, plus the actual IMAGE of one of them so you can look at it: pass `id` to view a specific generation (e.g. one you just started), or omit it to view the newest complete one. Use this to check whether a generation finished and to describe what was actually made — NEVER regenerate an image just because you can't see it; look first.",
			input_schema: {
				type: "object",
				properties: {
					id: {
						type: "string",
						description: "A specific image id to view (from generate_image's result). Omit for the newest complete image.",
					},
				},
			},
		},
		execute: (env, supabase, input) => viewGallery(env, supabase, input),
	},
];

/** The definitions every call starts with. A fresh array — runBrain mutates its copy as searches load tools. */
export const residentDefinitions = (): ToolDefinition[] =>
	REGISTRY.filter((e) => e.resident).map((e) => e.definition);

// ── Identity + capability resolution (Haven fork, 19 Jul 2026) ────────────────
// Registry text is written in template vocabulary — {user}, {companion},
// {companion_role}, {place}, plus the roster/mapping tokens below — and
// resolved per brain call against this context. On our install the resolved
// text reads exactly as the hardcoded originals did (the configured names, place and devices);
// on Haven it reads as that house is configured. The brain's method is
// untouched; its vocabulary now comes from data.

export type ToolResolutionContext = {
	profile: IdentityProfile;
	caps: CapabilityMap;
	vacuums: VacuumDef[] | null;
	mappings: WorkshopMappings | null;
};

/**
 * Build the per-call context. Every load is tolerant: a missing roster or
 * mapping just resolves its token to nothing — a half-configured house gets
 * honest generic text, never an error in the tool block.
 */
export async function buildToolContext(
	env: Env,
	supabase: SupabaseClient,
): Promise<ToolResolutionContext> {
	const [profile, elevenlabs, getimg, haUrl, haToken, notion, vacuums, mappings] =
		await Promise.all([
			loadIdentityProfile(env, supabase).catch(() => NEUTRAL_PROFILE),
			hasSecret(env, "ELEVENLABS_API_KEY"),
			hasSecret(env, "GETIMG_API_KEY"),
			hasSecret(env, "HA_MCP_URL"),
			hasSecret(env, "HA_TOKEN"),
			hasSecret(env, "NOTION_TOKEN"),
			loadVacuumRoster(env).catch(() => null),
			loadWorkshopMappings(env).catch(() => null),
		]);
	return {
		profile,
		caps: {
			elevenlabs,
			getimg,
			ha: haUrl && haToken,
			notion,
			// Spotify rides classic Wrangler secrets (OAuth triplet), not the store.
			spotify: Boolean(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET && env.SPOTIFY_REFRESH_TOKEN),
		},
		vacuums,
		mappings,
	};
}

/** Which capability group a tool needs, by name — central, no per-entry field. */
export function requiredCapability(name: string): Capability | null {
	if (name.startsWith("spotify_")) return "spotify";
	if (name.startsWith("ha_")) return "ha";
	if (name.startsWith("notion_") || name === "write_journal_entry" || name === "create_task") {
		return "notion";
	}
	if (name === "send_voice_note") return "elevenlabs";
	if (name === "generate_image" || name === "view_gallery") return "getimg";
	return null;
}

/** Resolve every template token in one string against the context. */
export function resolveRegistryText(text: string, ctx: ToolResolutionContext): string {
	const vacuumNames = (ctx.vacuums ?? []).map((v) => v.name);
	const areas: string[] = [];
	for (const v of ctx.vacuums ?? []) {
		for (const a of v.areas) if (!areas.includes(a)) areas.push(a);
	}
	const knownSources = ctx.mappings
		? ` Known data sources — {companion}'s Journal: ${ctx.mappings.journal_ds} (query this directly for recent journal entries, e.g. by Date, instead of searching); Tasks: ${ctx.mappings.tasks_ds}.`
		: "";
	return resolveIdentityText(
		text
			.replaceAll("{place}", tzPlace(ctx.profile.timezone))
			.replaceAll("{vacuums_parenthetical}", vacuumNames.length ? ` (${vacuumNames.join(", ")})` : "")
			.replaceAll("{vacuum_areas_sentence}", areas.length ? ` The mapped areas: ${areas.join(", ")}.` : "")
			.replaceAll("{known_sources}", knownSources),
		ctx.profile,
	);
}

// input_schema descriptions carry tokens too ({place} on date fields), so the
// resolver walks the schema structurally — never through JSON re-encoding,
// where a resolved name containing a quote would corrupt the document.
function deepResolveStrings(value: unknown, ctx: ToolResolutionContext): unknown {
	if (typeof value === "string") return resolveRegistryText(value, ctx);
	if (Array.isArray(value)) return value.map((v) => deepResolveStrings(v, ctx));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = deepResolveStrings(v, ctx);
		}
		return out;
	}
	return value;
}

/** The definitions as the model sees them — every token resolved. */
export function resolveDefinitions(
	defs: ToolDefinition[],
	ctx: ToolResolutionContext,
): ToolDefinition[] {
	return defs.map((d) => ({
		name: d.name,
		description: resolveRegistryText(d.description, ctx),
		input_schema: deepResolveStrings(d.input_schema, ctx) as Record<string, unknown>,
	}));
}

// ── search_tools matching ──────────────────────────────────────────────────────
// Deliberately dumb: word overlap between the model's plain-language `need` and
// each non-resident entry's curated match surface — name, blurb, keywords. The
// full description is deliberately NOT scored: it's prose written for the model,
// and its incidental words collide ("play some music" once matched the roster
// tool through "something" in its description). No embeddings, no similarity
// floor, nothing to tune — the model makes the fine pick from the shortlist it
// gets back. If this ever returns too much, tighten SHORTLIST_MAX, not the
// algorithm.

const SHORTLIST_MAX = 5;

// Words too generic to score on. NOT stopped: "all", "every", "list" — those are
// real signals (a roster ask), not filler.
const STOPWORDS = new Set([
	"the", "and", "for", "with", "that", "this", "what", "whats", "when",
	"where", "which", "who", "how", "her", "hers", "she", "his", "him", "its",
	"are", "was", "has", "have", "had", "can", "could", "would", "should",
	"need", "want", "get", "got", "about", "from", "into", "not", "but",
	"you", "your",
]);

function matchWords(s: string): string[] {
	return s
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// Whole-word match with cheap prefix stemming: "scheduled" finds "schedule",
// "colleagues" finds "colleague". The ≥4 guard keeps short words exact-only so
// "all" can't prefix its way into "allergy".
function wordsMatch(a: string, b: string): boolean {
	if (a === b) return true;
	if (a.length >= 4 && b.startsWith(a)) return true;
	if (b.length >= 4 && a.startsWith(b)) return true;
	return false;
}

/**
 * Non-resident entries matching `need`, best first, capped at SHORTLIST_MAX.
 * With a context (Haven fork): tools whose capability group has no key are
 * filtered out entirely — an unconfigured capability is simply not offered —
 * the match surface is resolved first (so a roster vacuum's name in a need
 * still finds the vacuum tools through the resolved blurb), and the install's own
 * names join the stopword list (the model's "Elle asks…" phrasing must not
 * skew scores toward every blurb carrying her name).
 */
export function searchTools(need: string, ctx?: ToolResolutionContext): ToolEntry[] {
	const dynamicStops = new Set(STOPWORDS);
	if (ctx) {
		for (const name of [ctx.profile.user_name, ctx.profile.companion_name]) {
			for (const w of name.toLowerCase().split(/[^a-z0-9]+/)) {
				if (w.length >= 3) {
					dynamicStops.add(w);
					dynamicStops.add(`${w}s`);
				}
			}
		}
	}
	const query = [...new Set(matchWords(need))].filter((w) => !dynamicStops.has(w));
	if (query.length === 0) return [];
	const scored: { entry: ToolEntry; score: number }[] = [];
	for (const entry of REGISTRY) {
		if (entry.resident) continue;
		const cap = requiredCapability(entry.definition.name);
		if (ctx && cap && !ctx.caps[cap]) continue;
		const blurb = entry.blurb ?? "";
		const surface = [
			...matchWords(entry.definition.name.replace(/_/g, " ")),
			...matchWords(ctx ? resolveRegistryText(blurb, ctx) : blurb),
			...(entry.keywords ?? []).map((k) => k.toLowerCase()),
		];
		let score = 0;
		for (const q of query) if (surface.some((s) => wordsMatch(q, s))) score++;
		if (score > 0) scored.push({ entry, score });
	}
	return scored
		.sort((a, b) => b.score - a.score)
		.slice(0, SHORTLIST_MAX)
		.map((s) => s.entry);
}

/** The tool_result fed back once runBrain has activated a shortlist. */
export function shortlistMessage(matches: ToolEntry[], ctx?: ToolResolutionContext): string {
	const lines = matches.map((m) => {
		const line = `- ${m.definition.name}: ${m.blurb ?? m.definition.description}`;
		return ctx ? resolveRegistryText(line, ctx) : line;
	});
	return `Now available — call the one you need:\n${lines.join("\n")}`;
}

/** The graceful is_error for a search that matched nothing. */
export function noMatchMessage(need: string): string {
	return `No tool matches "${need}" — that capability isn't built yet. Answer with what you already know, and say plainly if something's out of reach.`;
}

/**
 * A tool result's content is a plain string for every text tool, or an array
 * of Anthropic content blocks when a tool returns something the model must
 * SEE — view_gallery hands back the actual image as a base64 block (the
 * models are multimodal; a tool_result's content may be blocks). runBrain
 * forwards content verbatim either way.
 */
export type ToolResultBlock =
	| { type: "text"; text: string }
	| {
			type: "image";
			source: { type: "base64"; media_type: string; data: string };
	  };
export type ToolResult = { content: string | ToolResultBlock[]; is_error: boolean };

const ok = (content: string): ToolResult => ({ content, is_error: false });
const err = (content: string): ToolResult => ({ content, is_error: true });
const okBlocks = (blocks: ToolResultBlock[]): ToolResult => ({ content: blocks, is_error: false });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── Home Assistant dispatch (the ha_* entries → mcp.ts) ───────────────────────
// One funnel so the config check lives in exactly one place: missing secrets
// read as a plain is_error, never a fetch to "undefined". callMcpTool itself
// never throws, so these entries are best-effort end to end.
async function haCall(
	env: Env,
	tool: string,
	input: Record<string, unknown>,
): Promise<ToolResult> {
	// haServer resolves both HA secrets through the store; a missing one comes
	// back as an honest is_error naming the key and the Fuse Box, never a throw.
	let server;
	try {
		server = await haServer(env);
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}
	// Forward only what the model actually set — the HA intent handlers treat
	// an absent filter and an empty one differently.
	const args: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(input)) {
		if (v === undefined || v === null || v === "") continue;
		args[k] = v;
	}
	return callMcpTool(server, tool, args);
}

type MemRow = { title: string; content: string; type: string };

async function enumerateMemories(
	supabase: SupabaseClient,
	input: Record<string, unknown>,
): Promise<ToolResult> {
	const category = String(input.category ?? "");
	if (!CATEGORIES.includes(category)) {
		return err(`Unknown category "${category}". Valid: ${CATEGORIES.join(", ")}.`);
	}
	const type = input.type != null ? String(input.type) : null;
	if (type && !TYPES.includes(type)) {
		return err(`Unknown type "${type}". Valid: ${TYPES.join(", ")}.`);
	}
	const includeResolved = input.include_resolved === true;

	// No `core` filter: enumeration wants the complete set, core and non-core
	// alike. Resolved is excluded unless explicitly asked for.
	let q = supabase
		.from("memories")
		.select("title, content, type")
		.eq("active", true)
		.eq("category", category);
	if (type) q = q.eq("type", type);
	if (!includeResolved) q = q.neq("type", "resolved");

	const { data, error } = await q.order("title");
	if (error) return err(error.message);

	const rows = (data ?? []) as MemRow[];
	if (rows.length === 0) return ok(`No memories in category "${category}".`);
	const lines = rows.map((r) => `- (${r.type}) ${r.title}: ${r.content}`);
	return ok(`${rows.length} in "${category}":\n${lines.join("\n")}`);
}

type CalRow = {
	title: string;
	kind: string;
	course: string | null;
	starts_at: string | null;
	due_at: string | null;
	is_datetime: boolean;
	status: string | null;
	url: string | null;
};

function formatWhen(r: CalRow): string {
	const iso = r.starts_at ?? r.due_at;
	if (!iso) return "undated";
	const opts: Intl.DateTimeFormatOptions = r.is_datetime
		? { timeZone: "Australia/Perth", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }
		: { timeZone: "Australia/Perth", weekday: "short", day: "numeric", month: "short" };
	return new Intl.DateTimeFormat("en-GB", opts).format(new Date(iso));
}

function formatCalRow(r: CalRow): string {
	let line = `- ${r.title} [${r.kind}]`;
	if (r.course) line += ` (${r.course})`;
	line += ` — ${formatWhen(r)}`;
	if (r.due_at && r.due_at !== r.starts_at) {
		line += `, due ${formatWhen({ ...r, starts_at: r.due_at, is_datetime: false })}`;
	}
	if (r.status) line += `, ${r.status}`;
	if (r.url) line += ` ${r.url}`;
	return line;
}

async function readCalendar(
	supabase: SupabaseClient,
	input: Record<string, unknown>,
): Promise<ToolResult> {
	const start = String(input.start_date ?? "");
	const end = input.end_date != null ? String(input.end_date) : start;
	if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) {
		return err("Dates must be ISO format YYYY-MM-DD.");
	}

	const { data, error } = await supabase.rpc("read_calendar", {
		start_date: start,
		end_date: end,
	});
	if (error) return err(error.message);

	const rows = (data ?? []) as CalRow[];
	if (rows.length === 0) {
		return ok(`Nothing on the calendar between ${start} and ${end}.`);
	}
	const lines = rows.map(formatCalRow);
	return ok(`${rows.length} entries (${start} → ${end}):\n${lines.join("\n")}`);
}

// The single nearest active same-category memory, gate-free — see the
// match_memory_for_dedup migration for why this can't reuse match_memories.
type DedupRow = {
	id: string;
	type: string;
	core: boolean;
	active: boolean;
	title: string;
	content: string;
	tags: string[] | null;
	similarity: number;
	// The twin's row version at read time — the optimistic-lock key for the
	// reconcile UPDATE, so two Jays merging the same fact can't silently lose one.
	updated_at: string;
};

// The confirm step's verdict: are the two memories the same underlying fact, and
// if so, the reconciled (merged, current) content AND the best title for it.
type MemoryJudgment = {
	same_fact: boolean;
	reconciled_content?: string;
	reconciled_title?: string;
};

/**
 * The merge decision the embedding only NOMINATES. A cheap, separate Haiku call
 * (NOT the Front Room brain — same lightweight pattern as the Post Box title
 * suggester) decides whether a nominated twin is truly the same fact, and if so
 * reconciles old + new into the current truth rather than overwriting. Model-
 * agnostic: this holds whatever embedder we run. Throws on any failure so the
 * caller falls back to INSERT — a confirm failure can never touch an existing row.
 */
async function confirmSameFact(
	env: Env,
	incoming: { title: string; content: string },
	existing: { title: string; content: string },
): Promise<MemoryJudgment> {
	const anthropicKey = await getSecret(env, "ANTHROPIC_API_KEY");
	const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"x-api-key": anthropicKey,
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: "claude-haiku-4-5-20251001",
			max_tokens: 1024,
			system:
				"You decide whether two saved memories are the SAME underlying fact or DIFFERENT facts. Same fact = they describe the same thing about the same subject, even if worded differently or one carries an updated detail. Different facts = different subjects, or facts that can both be true at once (two different colleagues; a drink preference vs a food preference; a person vs that person's pet). Be conservative: if they are not clearly the same fact, answer different. Only when they are the same fact, reconcile them into one up-to-date statement that preserves every detail from both and prefers the newer wording where they genuinely conflict. Also choose the clearest, most representative TITLE for the merged fact: prefer whichever input title best describes the combined content; if the merged row broadens to cover more than one input describes, title it for the broader fact, not the newest detail; synthesize a fresh title only if neither input fits; and never narrow a general row down to its newest addition. Record your decision with the record_judgment tool.",
			messages: [
				{
					role: "user",
					content: `EXISTING memory:\nTitle: ${existing.title}\nContent: ${existing.content}\n\nINCOMING memory:\nTitle: ${incoming.title}\nContent: ${incoming.content}`,
				},
			],
			tools: [
				{
					name: "record_judgment",
					description:
						"Record whether the two memories are the same underlying fact, and if so the reconciled content and title.",
					input_schema: {
						type: "object",
						properties: {
							same_fact: {
								type: "boolean",
								description: "True only if the two memories are the same underlying fact.",
							},
							reconciled_content: {
								type: "string",
								description:
									"Required when same_fact is true: the single merged statement, preserving every detail from both and preferring the newer where they conflict.",
							},
							reconciled_title: {
								type: "string",
								description:
									"Required when same_fact is true: the clearest title for the merged fact — titled for the broader fact, never narrowed to its newest addition.",
							},
						},
						required: ["same_fact"],
					},
				},
			],
			tool_choice: { type: "tool", name: "record_judgment" },
		}),
	}, { service: "anthropic" });
	if (!res.ok) throw new Error(`confirm ${res.status}: ${await res.text()}`);
	const data = (await res.json()) as {
		content?: { type: string; input?: MemoryJudgment }[];
	};
	const block = (data.content ?? []).find((b) => b.type === "tool_use");
	if (!block?.input || typeof block.input.same_fact !== "boolean") {
		throw new Error("confirm returned no usable judgment");
	}
	return block.input;
}

/**
 * write_memory — the one tool on this loop that is not read-only. Its bounds are
 * exact and enforced here: it may only INSERT a new memory, or UPDATE the
 * content/title/tags/embedding of a near-duplicate it found. It never sets
 * `core`, never toggles `active`, never transitions `type`, never deletes, and
 * never touches another table. Best-effort like the rest: any failure returns
 * is_error and costs Jay nothing.
 */
async function writeMemory(
	env: Env,
	supabase: SupabaseClient,
	input: Record<string, unknown>,
): Promise<ToolResult> {
	const title = String(input.title ?? "").trim();
	const content = String(input.content ?? "").trim();
	const type = String(input.type ?? "");
	const category = String(input.category ?? "");
	if (!title) return err("A memory needs a title.");
	if (!content) return err("A memory needs content.");
	if (!WRITE_TYPES.includes(type)) {
		return err(`Type must be one of: ${WRITE_TYPES.join(", ")}.`);
	}
	if (!CATEGORIES.includes(category)) {
		return err(`Unknown category "${category}". Valid: ${CATEGORIES.join(", ")}.`);
	}
	// Normalise tags to a clean string[] (drop blanks/dupes); optional.
	const rawTags = Array.isArray(input.tags) ? input.tags : [];
	const tags = [...new Set(rawTags.map((t) => String(t).trim()).filter(Boolean))];

	// Embed FIRST, on the same `title\ncontent` shape the backfill used (see the
	// embed Edge Function) so this row sits in the same space as every other. If
	// the embed fails we abort before writing anything — no blind, unembedded row
	// ever enters the table.
	let embedding: number[];
	try {
		embedding = await embedText(env, `${title}\n${content}`.trim());
	} catch (e) {
		return err(`Couldn't embed the memory, so I didn't save it: ${e instanceof Error ? e.message : String(e)}`);
	}

	// Dedup: nearest active same-category memory, no taxonomy gates.
	const { data: matches, error: matchErr } = await supabase
		.rpc("match_memory_for_dedup", {
			query_embedding: embedding,
			target_category: category,
		})
		.select("id, type, core, active, title, content, tags, similarity, updated_at");
	if (matchErr) return err(`Dedup lookup failed: ${matchErr.message}`);

	const twin = ((matches ?? []) as DedupRow[])[0];

	// The INSERT path — the safe default everywhere below. A new non-core, active
	// row, embedded inline on the incoming text. core is always false (spine
	// promotion stays Elle's). Reused as the fallback whenever a merge can't be
	// made safely, so destruction is impossible by construction.
	const insertNew = async (): Promise<ToolResult> => {
		const { error: insErr } = await supabase.from("memories").insert({
			type,
			category,
			title,
			content,
			core: false,
			active: true,
			tags,
			embedding: JSON.stringify(embedding),
		});
		if (insErr) return err(`Save failed: ${insErr.message}`);
		return ok(JSON.stringify({ action: "created", title, type, category }));
	};

	// The embedding only NOMINATES — it does not decide. Below the loose
	// nomination floor there's no plausible twin, so this is simply a new fact.
	const nominated =
		twin != null && twin.similarity >= RETRIEVAL_CONFIG.memoryNominationThreshold;
	if (!nominated) return insertNew();

	// A plausible twin was nominated; the Haiku confirm makes the real call.
	// Best-effort: if it errors or returns nothing usable, fall back to INSERT —
	// never touch the existing row on a confirm failure.
	let judgment: MemoryJudgment;
	try {
		judgment = await confirmSameFact(
			env,
			{ title, content },
			{ title: twin.title, content: twin.content },
		);
	} catch {
		return insertNew();
	}

	// A false embedding match — different facts that merely scored close. Insert
	// separately; the original is untouched. A bad nomination now costs nothing.
	if (!judgment.same_fact) return insertNew();

	// Same fact. If the twin is core, the wall holds: it's already in the always-on
	// spine, so we neither modify the core row nor insert a duplicate of it. A real
	// *change* to a spine fact is a curation edit for Elle.
	if (twin.core) {
		return ok(
			JSON.stringify({
				action: "already_core",
				title: twin.title,
				note: "Already in your always-on spine; left unchanged. If it's genuinely changed, that's a core edit for Elle.",
			}),
		);
	}

	// The wall also covers `resolved`: a concluded memory is not a valid
	// auto-reconcile target. If a current fact matches one, the subject has become
	// current again — so leave the resolved row untouched and capture the fact as a
	// fresh active row instead. (Honours the memory-refresh "resolved untouched"
	// guardrail; sound for brain writes too.)
	if (twin.type === "resolved") return insertNew();

	// Same fact, non-core, not resolved → a real reconciliation, not an overwrite. The confirm
	// step merged old + new into the current truth; store that, re-embedded on the
	// reconciled text, with tags unioned. Preserve id / core / active / type by not
	// setting them. If the re-embed fails, fall back to INSERT so we never leave a
	// row whose vector is stale against its content — original still untouched.
	const reconciled = (judgment.reconciled_content ?? "").trim() || content;
	// The confirm step also picks the best title for the merged fact — it can keep
	// the incoming title (the Steff win), keep the existing one, or synthesize. We
	// embed and store that. Fall back to the EXISTING title, never the incoming
	// one, if it returned none: that's the safe, non-narrowing default. (28 Jun
	// fix: blindly taking the incoming title narrowed a collection row to its
	// newest member and buried the appearance row under a lore title.)
	const reconciledTitle = (judgment.reconciled_title ?? "").trim() || twin.title;
	let reconciledEmbedding: number[];
	try {
		reconciledEmbedding = await embedText(env, `${reconciledTitle}\n${reconciled}`.trim());
	} catch {
		return insertNew();
	}
	const mergedTags = [...new Set([...(twin.tags ?? []), ...tags])];
	const { data: updated, error: upErr } = await supabase
		.from("memories")
		.update({
			title: reconciledTitle,
			content: reconciled,
			tags: mergedTags,
			embedding: JSON.stringify(reconciledEmbedding),
			updated_at: new Date().toISOString(),
		})
		.eq("id", twin.id)
		// Optimistic lock: only merge if the twin hasn't changed since we read it.
		.eq("updated_at", twin.updated_at)
		.select("id");
	if (upErr) return err(`Update failed: ${upErr.message}`);
	// Zero rows updated → the other Jay reconciled this same twin in our window.
	// Don't clobber their merge; capture ours as a fresh row instead. A duplicate
	// Elle can tidy beats a silently lost merge — the module's own doctrine.
	if (!updated || updated.length === 0) return insertNew();
	return ok(JSON.stringify({ action: "reconciled", title: reconciledTitle, type: twin.type, category }));
}

/**
 * send_voice_note's executor. Two stages, each honest on failure (the hard
 * rule, learned 16 July: the brain must never be handed a success it can
 * narrate falsely — no "sent your voice note" over a dead ElevenLabs call):
 *
 *   1. Render: words → tagged script → transcript → audio → R2 (voice.ts).
 *      A failure here means nothing was persisted anywhere.
 *   2. Land it: a new `jay` message row whose text IS the transcript (the
 *      canon — the brain's history reads text, always) with the audio riding
 *      as metadata. Because the audio was stored in stage 1, a voice-note row
 *      can never point at audio that doesn't exist.
 *
 * The dev sandbox has no server-owned thread (persistence is deliberately
 * off), so there the note renders — proving the pipeline live — and the result
 * says plainly that nothing was persisted.
 */
async function sendVoiceNote(
	env: Env,
	supabase: SupabaseClient,
	input: Record<string, unknown>,
): Promise<ToolResult> {
	const content = String(input.content ?? "").trim();
	if (!content) return err("A voice note needs the words you want to say.");

	let note: Awaited<ReturnType<typeof renderVoiceNote>>;
	try {
		note = await renderVoiceNote(env, content);
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		return err(
			`The voice note was NOT sent — the render pipeline failed (${why}). ` +
				"Nothing landed in the thread. Tell Elle plainly; do not claim a voice note was sent.",
		);
	}

	if (env.ENVIRONMENT !== "production") {
		return ok(
			JSON.stringify({
				action: "voice_note_rendered_only",
				note: "Dev sandbox: audio rendered and stored, but the sandbox has no persistent thread — the note was NOT delivered as a message.",
				transcript: note.transcript,
				chars: note.chars,
			}),
		);
	}

	try {
		const conversationId = await getOrCreateActiveConversation(supabase, "front_room");
		await saveMessage(supabase, conversationId, "jay", note.transcript, voiceMetadata(note));
		await touchConversation(supabase, conversationId);
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		return err(
			`The voice note rendered but did NOT land in the thread (save failed: ${why}). ` +
				"Elle will not see or hear it. Tell her plainly; do not claim it was sent.",
		);
	}

	console.log(`voice note sent: ${note.key} (${note.chars} chars)`);
	return ok(
		JSON.stringify({
			action: "voice_note_sent",
			transcript: note.transcript,
			chars: note.chars,
		}),
	);
}

/**
 * generate_image's executor (the Gallery's vosjay door). Same honesty contract
 * as sendVoiceNote, with one twist: the pipeline finishes in the BACKGROUND
 * (getimg takes ~30s), so what this returns honestly is "started", never
 * "done" — the pending images row is the in-flight state, and the message row
 * saved here is what the Front Room renders the image into when it completes.
 *
 * Two stages:
 *   1. Start: validate → pending row → waitUntil continuation (gallery.ts).
 *      A rejection here means nothing was generated OR billed.
 *   2. Land the reference: a `jay` message row whose text is the intent, with
 *      metadata.image = { id } — the client polls that id and renders the
 *      image in the bubble when the row completes, with a Gallery link.
 */
async function generateImage(
	env: Env,
	supabase: SupabaseClient,
	input: Record<string, unknown>,
	extras?: ToolExtras,
): Promise<ToolResult> {
	const intent = String(input.intent ?? "").trim();
	if (!intent) return err("generate_image needs your intent — what the picture is of.");
	if (!extras?.waitUntil) {
		return err(
			"Image generation isn't available on this path (no background executor). No image was started.",
		);
	}

	const spec = modelSpec(DEFAULT_MODEL_ID)!;
	const aspect =
		typeof input.aspect_ratio === "string" && spec.aspectRatios.includes(input.aspect_ratio)
			? input.aspect_ratio
			: undefined;

	// The conversation link, resolved before the row is inserted so the
	// generation carries it from birth. Dev sandbox has no server-owned thread.
	const isProd = env.ENVIRONMENT === "production";
	let conversationId: string | null = null;
	if (isProd) {
		try {
			conversationId = await getOrCreateActiveConversation(supabase, "front_room");
		} catch {
			conversationId = null; // link is enrichment, never a dependency
		}
	}

	const id = crypto.randomUUID();
	const result = await startGeneration(
		env,
		supabase,
		{
			id,
			prompt: intent,
			path: "authored",
			source: "vosjay",
			model: DEFAULT_MODEL_ID,
			resolution: DEFAULT_RESOLUTION,
			...(aspect ? { aspect_ratio: aspect } : {}),
			...(typeof input.mood === "string" && input.mood ? { mood: input.mood } : {}),
			...(typeof input.location === "string" && input.location
				? { location: input.location }
				: {}),
			conversation_id: conversationId,
		},
		extras.waitUntil,
	);

	if (result.kind === "rejected") {
		return err(
			`The image was NOT started (${result.error}). Nothing was generated or billed. ` +
				"Tell Elle plainly; do not describe an image she isn't going to get.",
		);
	}

	if (!isProd) {
		return ok(
			JSON.stringify({
				action: "image_started_not_delivered",
				id,
				note: "Dev sandbox: the generation is running, but the sandbox has no persistent thread — nothing will land as a message.",
			}),
		);
	}

	try {
		if (!conversationId) throw new Error("no conversation to land in");
		await saveMessage(supabase, conversationId, "jay", intent, { image: { id } });
		await touchConversation(supabase, conversationId);
	} catch (e) {
		// The generation is still running and will reach the Gallery; only the
		// inline thread card is lost. Say exactly that.
		return ok(
			JSON.stringify({
				action: "image_started_gallery_only",
				id,
				note: `The image is generating and will land in the Gallery, but it could not be placed into the thread (${(e as Error).message}). Tell Elle to look in the Gallery in about half a minute.`,
			}),
		);
	}

	console.log(`image started: ${id} (vosjay)`);
	return ok(
		JSON.stringify({
			action: "image_started",
			id,
			note: "Generation takes about 30 seconds and lands in the thread + Gallery when done. Tell Elle it's on its way — do NOT claim it already exists, and don't describe details you haven't seen. To check on it or look at the result later, call view_gallery with this id — NEVER regenerate because you can't see it.",
		}),
	);
}

/**
 * view_gallery's executor: a recent-rows summary as text, plus the requested
 * (or newest complete) image as a real base64 image block — the brain looks
 * at what the house made instead of guessing or regenerating. Honest when
 * there's nothing to show: a pending row is named pending, a missing object
 * is named missing, and no picture is ever described that wasn't returned.
 */
async function viewGallery(
	env: Env,
	supabase: SupabaseClient,
	input: Record<string, unknown>,
): Promise<ToolResult> {
	const askedId = typeof input.id === "string" && input.id.trim() ? input.id.trim() : null;

	const { data, error } = await supabase
		.from("images")
		.select(
			"id, source, status, path, error, prompt_raw, prompt_rendered, model, aspect_ratio, resolution, cost, favourite, storage_path, thumbnail_path, created_at, completed_at",
		)
		.order("created_at", { ascending: false })
		.limit(8);
	if (error) return err(`Couldn't read the Gallery: ${error.message}`);
	const rows = (data ?? []) as ImageRow[];
	if (rows.length === 0) return ok(JSON.stringify({ images: [], note: "The Gallery is empty." }));

	const summary = rows.map((r) => ({
		id: r.id,
		source: r.source,
		status: r.status,
		...(r.error ? { error: r.error } : {}),
		prompt: r.prompt_raw,
		model: r.model,
		cost: r.cost,
		created_at: r.created_at,
	}));

	// Which image to actually show: the asked-for row, else the newest complete.
	const target = askedId
		? rows.find((r) => r.id === askedId)
		: rows.find((r) => r.status === "complete");

	// The asked-for row might be older than the summary window — fetch it alone.
	let viewed = target;
	if (askedId && !viewed) {
		const { data: one } = await supabase.from("images").select("*").eq("id", askedId).maybeSingle();
		viewed = (one as ImageRow) ?? undefined;
	}

	const summaryText = (note: string) =>
		JSON.stringify({ note, images: summary });

	if (!viewed) {
		return ok(
			summaryText(
				askedId
					? `No image with id ${askedId} exists — it may have been deleted.`
					: "Nothing complete to view yet.",
			),
		);
	}
	if (viewed.status !== "complete") {
		return ok(
			summaryText(
				`Image ${viewed.id} is ${viewed.status}${viewed.error ? ` (${viewed.error})` : ""} — nothing to look at ${viewed.status === "pending" ? "yet; check again shortly. Do NOT regenerate it" : "; it can be retried from the Gallery grid"}.`,
			),
		);
	}
	const img = await imageAsBase64(env, viewed);
	if (!img) {
		return ok(summaryText(`Image ${viewed.id} is complete but its file is missing from storage.`));
	}
	return okBlocks([
		{
			type: "text",
			text: summaryText(
				`The image below is ${viewed.id} (${viewed.source}): "${viewed.prompt_raw}". Describe only what you actually see in it.`,
			),
		},
		{ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } },
	]);
}

/**
 * Run one tool call, dispatched through the registry. Never throws — any
 * failure becomes an is_error result so the model can recover and still answer.
 */
export async function runTool(
	env: Env,
	supabase: SupabaseClient,
	name: string,
	input: Record<string, unknown>,
	extras?: ToolExtras,
): Promise<ToolResult> {
	const entry = REGISTRY.find((e) => e.definition.name === name);
	if (!entry) return err(`Unknown tool "${name}".`);
	try {
		return await entry.execute(env, supabase, input, extras);
	} catch (e) {
		return err(`Tool "${name}" failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}
