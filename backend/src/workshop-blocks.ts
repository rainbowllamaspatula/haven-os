/**
 * Generic parent blocks — the Workshop's composable tier (18 Jul brief).
 *
 * A block is data (workshop.blocks in the config bag): one or more Notion
 * sources merged into ONE list sorted by a chosen property, each tile tagged
 * with its source so the frontend paints the right VDS accent bar. Properties
 * are chosen per source; the renderer supports exactly five types (title,
 * date, status, select, multi_select — the glance-and-pick set, Elle 18 Jul).
 * Anything else renders an honest "—", never a guess — Asher's databases will
 * have types we've never seen, and a dash degrades where an error would break.
 *
 * Read-only, human-eyes-only: no writes, and the brain gets no tile tool —
 * the Workshop is deliberately Elle's reading room.
 *
 * Query plumbing (pagination, database-vs-data-source drift) is projects.ts's
 * queryAll, reused not re-grown. Cache is the house 60s + last-good, keyed by
 * the block's own definition so a panel edit is never served a stale shape.
 */

import { fetchWithTimeout } from "./http";
import { queryAll, authHeaders, type NotionPage } from "./projects";
import type { WorkshopBlock } from "./config";

const NOTION_API = "https://api.notion.com/v1";

// The five supported property types — chosen by what helps you PICK a row.
export const SUPPORTED_TYPES = ["title", "date", "status", "select", "multi_select"] as const;

// ── The tile shape the room renders ─────────────────────────────────────────

export type TileChip = { label: string; color: string };
export type TileProp =
	| { name: string; kind: "date"; value: string | null }
	| { name: string; kind: "chips"; chips: TileChip[] }
	| { name: string; kind: "dash" };

export type BlockTile = {
	id: string;
	url: string;
	title: string;
	/** The data_source_id this row came from — the frontend's accent key. */
	source: string;
	props: TileProp[];
};

// ── Schema (the Fuse Box builder's per-source property list) ────────────────

export type SchemaProp = { name: string; type: string; supported: boolean };

/**
 * Fetch a data source's schema for the builder. Reads each property entry's
 * own name/type fields — never the map keys, whose keying the API docs leave
 * ambiguous (name vs id). Title is excluded: it always renders, it's not a
 * choice.
 */
export async function getDataSourceSchema(env: Env, dataSourceId: string): Promise<SchemaProp[]> {
	const res = await fetchWithTimeout(
		`${NOTION_API}/data_sources/${dataSourceId}`,
		{ headers: await authHeaders(env) },
		{ service: "notion" },
	);
	if (!res.ok) {
		throw new Error(`Notion schema read [${dataSourceId}] -> ${res.status}: ${await res.text()}`);
	}
	const body = (await res.json()) as {
		properties?: Record<string, { name?: string; type?: string }>;
	};
	return Object.values(body.properties ?? {})
		.map((p) => ({ name: p.name ?? "", type: p.type ?? "unknown" }))
		.filter((p) => p.name && p.type !== "title")
		.map((p) => ({
			...p,
			supported: (SUPPORTED_TYPES as readonly string[]).includes(p.type),
		}))
		.sort((a, b) => Number(b.supported) - Number(a.supported) || a.name.localeCompare(b.name));
}

// ── Tile extraction (pure — exported for tests) ─────────────────────────────

// A page property VALUE, loosely — the `type` field drives extraction, and
// select/status/multi_select options carry Notion's read-only colour
// (verified against the live API reference, 18 Jul).
type GenericProp = {
	type?: string;
	title?: Array<{ plain_text?: string }>;
	date?: { start?: string } | null;
	select?: { name?: string; color?: string } | null;
	status?: { name?: string; color?: string } | null;
	multi_select?: Array<{ name?: string; color?: string }>;
};

const chip = (o: { name?: string; color?: string } | null | undefined): TileChip | null =>
	o?.name ? { label: o.name, color: o.color ?? "default" } : null;

/** One chosen property → its tile rendering. Unsupported or absent → dash. */
export function extractProp(name: string, prop: GenericProp | undefined): TileProp {
	if (!prop) return { name, kind: "dash" };
	switch (prop.type) {
		case "date":
			return { name, kind: "date", value: prop.date?.start ?? null };
		case "status": {
			const c = chip(prop.status);
			return { name, kind: "chips", chips: c ? [c] : [] };
		}
		case "select": {
			const c = chip(prop.select);
			return { name, kind: "chips", chips: c ? [c] : [] };
		}
		case "multi_select":
			return {
				name,
				kind: "chips",
				chips: (prop.multi_select ?? []).map(chip).filter((c): c is TileChip => c !== null),
			};
		default:
			return { name, kind: "dash" };
	}
}

function pageTitle(properties: Record<string, GenericProp>): string {
	for (const p of Object.values(properties)) {
		if (p?.type === "title" || Array.isArray(p?.title)) {
			const t = (p.title ?? []).map((r) => r.plain_text ?? "").join("").trim();
			return t || "(untitled)";
		}
	}
	return "(untitled)";
}

/** Build one tile: title + the source's chosen properties, in chosen order. */
export function buildTile(page: NotionPage, sourceId: string, chosen: string[]): BlockTile {
	const props = page.properties as Record<string, GenericProp>;
	return {
		id: page.id,
		url: page.url,
		title: pageTitle(props),
		source: sourceId,
		props: chosen.map((name) => extractProp(name, props[name])),
	};
}

// ── Merge + sort (pure — exported for tests) ────────────────────────────────

/**
 * The sort key for a tile under the block's sort property: "title" sorts by
 * the tile heading; otherwise the named property's comparable text (date →
 * ISO start, which sorts lexically; status/select → the first chip label).
 * Tiles with no value sort last in either direction — "what's due next"
 * shouldn't open with the undated.
 */
export function sortKey(tile: BlockTile, property: string): string | null {
	if (property === "title") return tile.title.toLowerCase();
	const p = tile.props.find((x) => x.name === property);
	if (!p) return null;
	if (p.kind === "date") return p.value;
	if (p.kind === "chips") return p.chips[0]?.label.toLowerCase() ?? null;
	return null;
}

export function mergeAndSort(
	tiles: BlockTile[],
	sort: { property: string; direction: "asc" | "desc" },
): BlockTile[] {
	const dir = sort.direction === "desc" ? -1 : 1;
	return [...tiles].sort((a, b) => {
		const ka = sortKey(a, sort.property);
		const kb = sortKey(b, sort.property);
		if (ka === null && kb === null) return 0;
		if (ka === null) return 1; // valueless last, regardless of direction
		if (kb === null) return -1;
		return ka.localeCompare(kb) * dir;
	});
}

// ── The cached block read (60s + last-good, house pattern) ──────────────────

const BLOCK_TTL_MS = 60_000; // uniform, no per-block knob (Elle, 18 Jul)
const CACHE_MAX = 16;
// Keyed by the block's full definition, so a panel edit (new source, new
// sort, new properties) misses the cache instead of serving the old shape —
// the same freshness the scenes amendment proved config deserves.
const blockCache = new Map<string, { at: number; tiles: BlockTile[] }>();

export function bustBlockCache(): void {
	blockCache.clear();
}

export async function getBlockTiles(env: Env, block: WorkshopBlock): Promise<BlockTile[]> {
	const key = JSON.stringify(block);
	const now = Date.now();
	const hit = blockCache.get(key);
	if (hit && now - hit.at < BLOCK_TTL_MS) return hit.tiles;

	try {
		// Every source queried, each tile tagged with its source, one sorted list.
		const perSource = await Promise.all(
			block.sources.map(async (s) => {
				const pages = await queryAll(env, s.data_source_id);
				return pages.map((p) => buildTile(p, s.data_source_id, s.properties));
			}),
		);
		const tiles = mergeAndSort(perSource.flat(), block.sort);
		if (blockCache.size >= CACHE_MAX && !blockCache.has(key)) {
			const oldest = blockCache.keys().next().value;
			if (oldest !== undefined) blockCache.delete(oldest);
		}
		blockCache.set(key, { at: now, tiles });
		return tiles;
	} catch (err) {
		if (hit) return hit.tiles; // last-good beats a blank block
		throw err;
	}
}
