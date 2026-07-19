/**
 * Projects reader — live, read-only view of the EV25 - Projects Notion database.
 *
 * The Workshop Projects tool's one source. Deliberately NOT a Supabase mirror
 * (see the build brief's locked decision): Projects feeds one occasional panel
 * with no ambient tile and no brain tool, so it reads Notion live behind a short
 * in-Worker cache rather than earning a cron mirror the way the calendar did.
 *
 * The reader pattern (auth headers, paged query, database-vs-data-source ID
 * resolution) is adapted from calendar-sync/src/notion.ts — borrowed, not shared:
 * this is a standalone copy so vale-os-backend doesn't depend on that Worker.
 *
 * Read-only: this only ever issues queries against Notion. Nothing is written —
 * not to Notion, not to Supabase.
 */

import { fetchWithTimeout } from "./http";
import { getSecret } from "./secrets";
import { loadWorkshopMappings } from "./config";

const NOTION_API = "https://api.notion.com/v1";

// The EV25 - Projects database. The data-source (collection) ID is the primary
// handle; queryAll() falls back to resolving it as a database ID if Notion 404s
// (the 2025-09-03 API splits a database into one or more data sources).
// The Projects data source id lives in workshop.mappings config now (Fuse
// Box Phase 6) — loaded per fetch, so a repoint is live without a deploy.

// Property names on EV25 - Projects (live schema, verified in the brief).
const PROP = {
	title: "Project",
	status: "Status",
	priority: "Priority",
	category: "Category",
	target: "Target",
	completion: "Completion Date",
} as const;

// One project as the Workshop tool needs it. Sorting and the status→pill mapping
// are the client's job; this stays the raw, thin data shape. Dates are the raw
// Notion `start` (date-only "YYYY-MM-DD" or null) — the client formats them
// Perth-safely.
export type Project = {
	id: string;
	project: string;
	status: string | null;
	priority: string | null;
	category: string[];
	target: string | null;
	completion_date: string | null;
	url: string;
};

// --- Notion property types we read (loose; Notion's payload is large) ---
type RichText = { plain_text: string };
type NotionDateValue = { start: string; end: string | null } | null;
type NotionProp = {
	title?: RichText[];
	date?: NotionDateValue;
	select?: { name: string } | null;
	multi_select?: { name: string }[];
	status?: { name: string } | null;
};
// Exported for workshop-blocks.ts (generic parent blocks, 18 Jul) — the
// generic tier reuses this reader's pagination + ID-drift handling verbatim
// rather than growing a second Notion query path. Projects' own behavior is
// untouched; these are `export` keywords, nothing more.
export type NotionPage = { id: string; url: string; properties: Record<string, NotionProp> };

export async function authHeaders(env: Env): Promise<Record<string, string>> {
	return {
		Authorization: `Bearer ${await getSecret(env, "NOTION_TOKEN")}`,
		"Notion-Version": env.NOTION_VERSION,
		"Content-Type": "application/json",
	};
}

/**
 * If a configured ID isn't a data source (404), it may be a database ID — in the
 * 2025-09-03 API a database holds one or more data sources. Resolve to the first
 * data source so the query can proceed.
 */
async function resolveViaDatabase(env: Env, id: string): Promise<string | null> {
	const res = await fetchWithTimeout(`${NOTION_API}/databases/${id}`, { headers: await authHeaders(env) }, { service: "notion" });
	if (!res.ok) return null;
	const body = (await res.json()) as { data_sources?: { id: string }[] };
	return body.data_sources?.[0]?.id ?? null;
}

/** Query every page of a data source, resolving database-vs-data-source ID drift once. */
export async function queryAll(env: Env, dataSourceId: string): Promise<NotionPage[]> {
	let dsId = dataSourceId;
	let resolved = false;
	const out: NotionPage[] = [];
	let cursor: string | undefined;

	do {
		const body: Record<string, unknown> = { page_size: 100 };
		if (cursor) body.start_cursor = cursor;

		const res = await fetchWithTimeout(
			`${NOTION_API}/data_sources/${dsId}/query`,
			{
				method: "POST",
				headers: await authHeaders(env),
				body: JSON.stringify(body),
			},
			{ service: "notion" },
		);

		if (res.status === 404 && !resolved) {
			const alt = await resolveViaDatabase(env, dataSourceId);
			resolved = true;
			if (alt && alt !== dsId) {
				dsId = alt;
				continue; // retry this page against the resolved data source
			}
		}
		if (!res.ok) {
			throw new Error(`Notion query [${dataSourceId}] -> ${res.status}: ${await res.text()}`);
		}

		const data = (await res.json()) as {
			results: NotionPage[];
			has_more: boolean;
			next_cursor: string | null;
		};
		out.push(...data.results);
		cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
	} while (cursor);

	return out;
}

// --- Property extractors ---
function plainTitle(prop: NotionProp | undefined): string {
	return (prop?.title ?? []).map((t) => t.plain_text).join("").trim();
}
function getSelect(prop: NotionProp | undefined): string | null {
	return prop?.select?.name ?? prop?.status?.name ?? null;
}
function getMultiSelect(prop: NotionProp | undefined): string[] {
	return (prop?.multi_select ?? []).map((o) => o.name);
}
// The raw date `start` (date-only "YYYY-MM-DD" or a datetime), or null. The
// client formats it; the reader doesn't parse it into a Date (which would risk a
// timezone shift on a date-only value).
function getDateStart(prop: NotionProp | undefined): string | null {
	return prop?.date?.start ?? null;
}

function buildProject(page: NotionPage): Project {
	const props = page.properties;
	return {
		id: page.id,
		project: plainTitle(props[PROP.title]) || "(untitled)",
		status: getSelect(props[PROP.status]),
		priority: getSelect(props[PROP.priority]),
		category: getMultiSelect(props[PROP.category]),
		target: getDateStart(props[PROP.target]),
		completion_date: getDateStart(props[PROP.completion]),
		url: page.url,
	};
}

// Short in-Worker cache — the "Cathedral cache" default. The panel is an
// occasional scan, so freshness-within-a-minute is ample; the cache just stops
// rapid re-opens hammering the Notion API. Per-isolate and best-effort by
// design — that's all this needs to be.
const PROJECTS_CACHE_TTL_MS = 60_000;
let cache: { at: number; data: Project[] } | null = null;

/**
 * The EV25 projects, live (cached ~60s). On a failed read, serve last-good
 * rather than blanking; only a failure with no last-good throws, so the route
 * can surface it.
 */
export async function getProjects(env: Env): Promise<Project[]> {
	const now = Date.now();
	if (cache && now - cache.at < PROJECTS_CACHE_TTL_MS) return cache.data;

	try {
		const pages = await queryAll(env, (await loadWorkshopMappings(env)).projects_ds);
		const data = pages.map(buildProject);
		cache = { at: now, data };
		return data;
	} catch (err) {
		if (cache) return cache.data; // last-good beats a blank panel
		throw err;
	}
}
