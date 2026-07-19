/**
 * Notion cathedral finder — the Workshop Notion tool's source.
 *
 * A read-only window across the whole cathedral (everything the integration sees
 * under SnuggleZone): a recently-edited list by default, full-text search on a
 * query, each result tagged with the **area** it lives in so the UI can spine it.
 *
 * Two genuinely-new pieces versus the Projects reader:
 *   1. It reads across everything via Notion's search endpoint, not one database.
 *   2. Area resolution by an **ancestry walk** — Notion hands back only one parent
 *      level, but pages nest (the Progress Log is three hops under the Projects
 *      DB), so we walk parents up to a known root, memoising shared ancestors,
 *      capping depth, and defaulting to neutral. This is the budgeted hard part.
 *
 * Read-only: only ever issues GET/search against Notion. Nothing is written.
 */

import { createClient } from "@supabase/supabase-js";
import { fetchWithTimeout } from "./http";
import { getSecret } from "./secrets";
import { loadWorkshopMappings } from "./config";

const NOTION_API = "https://api.notion.com/v1";

// Known roots for area detection, normalised (dashes stripped, lower-cased) so
// dashed and undashed ids compare equal. WAS five hardcoded ids from the build
// brief; NOW workshop.mappings config (Fuse Box Phase 6), loaded once per
// search request and threaded through the walk — never per result.
const norm = (id: string) => id.replace(/-/g, "").toLowerCase();

type NotionRoots = {
	journalDs: string;
	projectsDb: string;
	projectsDs: string;
	jayhqPage: string;
	snugglezone: string;
	/** Db/data-source title prefixes excluded from the finder (config; was a hardcoded regex). */
	excludePrefixes: string[];
};

async function loadRoots(env: Env): Promise<NotionRoots> {
	const m = await loadWorkshopMappings(env);
	// The exclude list is optional config (`workshop.finder_excludes`, an array
	// of title prefixes, case-insensitive) — absence just means nothing excluded.
	let excludePrefixes: string[] = [];
	try {
		const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
			auth: { persistSession: false, autoRefreshToken: false },
		});
		const { data } = await supabase
			.from("preferences")
			.select("value")
			.eq("key", "workshop.finder_excludes")
			.maybeSingle();
		if (Array.isArray(data?.value)) {
			excludePrefixes = (data.value as unknown[])
				.map((v) => String(v).trim().toLowerCase())
				.filter(Boolean);
		}
	} catch {
		// Best-effort — a failed read only widens the finder, never breaks it.
	}
	return {
		journalDs: norm(m.journal_ds),
		projectsDb: norm(m.projects_db),
		projectsDs: norm(m.projects_ds),
		jayhqPage: norm(m.jayhq_page),
		snugglezone: norm(m.snugglezone_page),
		excludePrefixes,
	};
}

// How far up the ancestry to walk before giving up and defaulting to neutral.
// Six covers the deepest known case (page → Projects row → data source →
// database → its page → …) with headroom.
const WALK_CAP = 6;

/** The area a result lives in — drives the spine colour on the client. */
export type Area = "journal" | "jayhq" | "project-child" | "other-ev25" | "else";

/** One search/recent result, with its resolved area. */
export type NotionResult = {
	id: string;
	title: string;
	url: string;
	last_edited_time: string;
	area: Area;
	breadcrumb: string | null;
};

// --- Notion shapes (loose; the payload is large) ---
type ParentRef =
	| { type: "data_source_id"; data_source_id: string; database_id?: string }
	| { type: "database_id"; database_id: string }
	| { type: "page_id"; page_id: string }
	| { type: "block_id"; block_id: string }
	| { type: "workspace"; workspace: true };
type RichText = { plain_text: string };
type NotionProp = { type: string; title?: RichText[] };
type NotionPage = {
	object: "page" | "database" | string;
	id: string;
	url: string;
	last_edited_time: string;
	parent: ParentRef;
	properties?: Record<string, NotionProp>;
	title?: RichText[]; // databases carry their title here
};

export async function authHeaders(env: Env): Promise<Record<string, string>> {
	return {
		Authorization: `Bearer ${await getSecret(env, "NOTION_TOKEN")}`,
		"Notion-Version": env.NOTION_VERSION,
		"Content-Type": "application/json",
	};
}

/** The plain title of a page (its title-typed property) or a database (top-level title). */
function resultTitle(node: NotionPage): string {
	if (node.title?.length) return node.title.map((t) => t.plain_text).join("").trim();
	for (const prop of Object.values(node.properties ?? {})) {
		if (prop.type === "title") return (prop.title ?? []).map((t) => t.plain_text).join("").trim();
	}
	return "";
}

// --- Ancestry resolution ---
// The id a parent ref points at, normalised — or null for workspace/unknown.
function parentId(ref: ParentRef | undefined): string | null {
	if (!ref) return null;
	switch (ref.type) {
		case "data_source_id":
			return norm(ref.data_source_id);
		case "database_id":
			return norm(ref.database_id);
		case "page_id":
			return norm(ref.page_id);
		case "block_id":
			return norm(ref.block_id);
		default:
			return null; // workspace / unrecognised
	}
}

// A node fetched while walking: its own parent ref, plus (for databases/data
// sources) its title, so "other EV25 database" can be detected by title prefix.
type NodeInfo = { parent: ParentRef | undefined; title: string };

// Persistent memo of id → node info. Ancestry structure is effectively immutable
// for our purposes, so caching across requests means the shared spine of the
// cathedral (the Projects DB, SnuggleZone) is fetched once per isolate, not once
// per result.
const nodeMemo = new Map<string, NodeInfo>();

/** Fetch a page / database / data source by id (memoised) and return its parent + title. */
async function fetchNode(env: Env, ref: ParentRef): Promise<NodeInfo | null> {
	const id = parentId(ref);
	if (!id) return null;
	const cached = nodeMemo.get(id);
	if (cached) return cached;

	const path =
		ref.type === "data_source_id"
			? `data_sources/${id}`
			: ref.type === "database_id"
				? `databases/${id}`
				: ref.type === "block_id"
					? `blocks/${id}`
					: `pages/${id}`;

	const res = await fetchWithTimeout(`${NOTION_API}/${path}`, { headers: await authHeaders(env) }, { service: "notion" });
	if (!res.ok) return null; // unreadable ancestor — stop the walk, default neutral
	const node = (await res.json()) as NotionPage;
	const info: NodeInfo = { parent: node.parent, title: resultTitle(node) };
	nodeMemo.set(id, info);
	return info;
}

// Is this ref the Projects database or its data source?
function isProjects(roots: NotionRoots, ref: ParentRef): boolean {
	const id = parentId(ref);
	return id === roots.projectsDb || id === roots.projectsDs;
}

/**
 * Resolve a result's area by walking its ancestry to a known root.
 *
 * Precedence (first match wins): Journal → Jay HQ → project-child → other-EV25 →
 * else. Journal and Jay HQ short-circuit the moment they're seen (they're
 * highest); Projects and other-EV25 are flagged and settled after the walk so
 * project-child stays ahead of other-EV25.
 *
 * Returns null for an excluded result — a Projects tracker *row* (direct parent
 * is the Projects data source). The Projects tool owns those; their child pages
 * stay in (they resolve to project-child).
 */
async function resolveArea(
	env: Env,
	roots: NotionRoots,
	selfId: string,
	parent: ParentRef,
): Promise<{ area: Area; breadcrumb: string | null } | null> {
	// Exclusion: a row sits directly in the Projects data source.
	if (parent.type === "data_source_id" && norm(parent.data_source_id) === roots.projectsDs) {
		return null;
	}

	// A root counts as belonging to its own area — the anchor page is part of the
	// area, not just its descendants. Without this the Jay HQ root page itself
	// resolves grey while everything under it is bronze, because the walk only
	// ever sees *ancestors*, never the result's own id. Generalised to every
	// page-anchored root so the identical edge can't bite another later. (Journal
	// and Projects are anchored on data sources, never returned as page results,
	// so they're immune; the SnuggleZone root maps to else either way, kept here
	// for the principle.)
	if (selfId === roots.jayhqPage) return { area: "jayhq", breadcrumb: null };
	if (selfId === roots.snugglezone) return { area: "else", breadcrumb: null };

	let ref: ParentRef | undefined = parent;
	let depth = 0;
	let sawProjects = false;
	let sawOtherEv25 = false;
	let breadcrumb: string | null = null;

	while (ref && depth < WALK_CAP) {
		depth++;
		if (ref.type === "workspace") break;
		const id = parentId(ref);
		if (id === roots.journalDs) return { area: "journal", breadcrumb };
		if (id === roots.jayhqPage) return { area: "jayhq", breadcrumb };
		if (id === roots.snugglezone) break; // reached the cathedral root — nothing more specific above
		if (isProjects(roots, ref)) sawProjects = true;

		const info = await fetchNode(env, ref);
		if (!info) break;
		// The nearest named ancestor becomes the breadcrumb (best-effort).
		if (!breadcrumb && info.title) breadcrumb = info.title;
		// Configured exclude prefixes (workshop.finder_excludes) drop whole
		// database subtrees from the finder — ours excludes the school databases,
		// which were swamping the recent list. Prefix-matched so a future year's
		// db is covered too.
		if (
			(ref.type === "database_id" || ref.type === "data_source_id") &&
			roots.excludePrefixes.some((p) => info.title.toLowerCase().startsWith(p))
		) {
			return null;
		}
		// "Other EV25 database": a db/data-source titled "EV25…" that isn't
		// Projects or the Journal (both handled above).
		if (
			(ref.type === "database_id" || ref.type === "data_source_id") &&
			!isProjects(roots, ref) &&
			/^ev25/i.test(info.title)
		) {
			sawOtherEv25 = true;
		}
		ref = info.parent;
	}

	if (sawProjects) return { area: "project-child", breadcrumb };
	if (sawOtherEv25) return { area: "other-ev25", breadcrumb };
	return { area: "else", breadcrumb };
}

// --- Search ---
/** Hit Notion's search endpoint. Empty query = the recent list (last-edited desc). */
async function notionSearch(env: Env, query: string): Promise<NotionPage[]> {
	const body: Record<string, unknown> = {
		filter: { value: "page", property: "object" },
		sort: { direction: "descending", timestamp: "last_edited_time" },
		page_size: 25,
	};
	if (query) body.query = query;

	const res = await fetchWithTimeout(
		`${NOTION_API}/search`,
		{
			method: "POST",
			headers: await authHeaders(env),
			body: JSON.stringify(body),
		},
		{ service: "notion" },
	);
	if (!res.ok) throw new Error(`Notion search -> ${res.status}: ${await res.text()}`);
	const data = (await res.json()) as { results: NotionPage[] };
	return data.results ?? [];
}

/** Search, then resolve each result's area. Excluded rows are dropped. */
async function searchWithAreas(env: Env, query: string): Promise<NotionResult[]> {
	// The roots load ONCE per search and thread through every result's walk.
	const [pages, roots] = await Promise.all([notionSearch(env, query), loadRoots(env)]);
	const out: NotionResult[] = [];
	for (const page of pages) {
		const resolved = await resolveArea(env, roots, norm(page.id), page.parent);
		if (!resolved) continue; // excluded Projects row
		out.push({
			id: page.id,
			title: resultTitle(page) || "(untitled)",
			url: page.url,
			last_edited_time: page.last_edited_time,
			area: resolved.area,
			breadcrumb: resolved.breadcrumb,
		});
	}
	return out;
}

// Short cache on the recent list only — it's the same re-opened glance, so
// freshness-within-a-minute is ample and rapid re-opens stay off the API.
// Search is per-query and uncached. Last-good is served on a failed recent read.
const RECENT_CACHE_TTL_MS = 60_000;
let recentCache: { at: number; data: NotionResult[] } | null = null;

/** The recently-edited list (cached ~60s, last-good on failure). */
export async function getRecent(env: Env): Promise<NotionResult[]> {
	const now = Date.now();
	if (recentCache && now - recentCache.at < RECENT_CACHE_TTL_MS) return recentCache.data;
	try {
		const data = await searchWithAreas(env, "");
		recentCache = { at: now, data };
		return data;
	} catch (err) {
		if (recentCache) return recentCache.data;
		throw err;
	}
}

/** Search the cathedral for a query. Uncached — each query is its own ask. */
export async function searchNotion(env: Env, query: string): Promise<NotionResult[]> {
	return searchWithAreas(env, query);
}

/**
 * The brain-tool search: raw results, NO area walk. The ancestry resolution
 * above exists for the finder UI's spine colours; for the brain it's dozens of
 * hidden per-result fetches that blew the Worker's subrequest ceiling on a
 * two-search turn (seen live 2 Jul 2026). One subrequest, titles + ids — the
 * model follows up with notion_read_page anyway.
 */
export async function searchNotionLight(
	env: Env,
	query: string,
): Promise<{ id: string; title: string; last_edited_time: string }[]> {
	const pages = await notionSearch(env, query);
	return pages.map((p) => ({
		id: p.id,
		title: resultTitle(p) || "(untitled)",
		last_edited_time: p.last_edited_time,
	}));
}
