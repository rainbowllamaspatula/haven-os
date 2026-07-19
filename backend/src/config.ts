/**
 * Per-install config — the Fuse Box Phase 6 loaders.
 *
 * The Hearth's registry (which lights make a scene, the preset values, the
 * goodnight ritual) and the Workshop's mappings (where in Notion everything
 * points) live in the `preferences` bag under namespaced keys, edited by the
 * Fuse Box, seeded by migration with the values that used to be hardcoded.
 * This is what makes both subsystems portable: Haven points them at Asher's
 * house with rows, not code.
 *
 * House rules, same as every config read since the cutover:
 *  - Per-request, never cached in module scope — a panel edit is live on the
 *    next call.
 *  - Fail LOUD naming the key and the fix; a missing row is a real error,
 *    never a silent fallback to stale constants (the constants are gone).
 *
 * Scenes are FULLY config since the same-day amendment (Elle, 18 Jul): an
 * ordered array of {name, icon, values} — name is the chip label AND the
 * API identifier, icon is a Tabler class, values are arity-locked to the
 * light count. Add a scene in the panel, get a chip in the Hearth. (The
 * original fixed-four ruling lasted about two hours, which is the panel
 * working as intended.)
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type SceneDef = { name: string; icon: string; values: number[] };

export type HearthRegistry = {
	scene_lights: string[];
	scenes: SceneDef[];
	goodnight: { light: string; brightness: number };
};

/**
 * The Hearth Registry extension (18 Jul brief): the two device rosters that
 * make the room target THIS house's devices instead of ours hardcoded.
 *
 * Vacuums are name + cleanable areas — the two-level part. HA does NOT expose
 * which areas a vacuum can clean (verified live 18 Jul: the vacuum's live-
 * context block and full attributes carry no room list, and the rail can only
 * name areas that contain an exposed entity — Study/Hallway/Laundry Room are
 * invisible to it). So areas are CURATED config: fetch assists where it can,
 * typed names are checked against the rail's area oracle at add time
 * (GetLiveContext's area filter — "does not exist" vs "no exposed entities").
 *
 * Audio is two-level by design: areas, each containing one or more speakers
 * (one-per-room today; VHS's many-per-room fits with no rebuild), plus the
 * Everywhere group — deliberately its own slot, never just another area.
 */
export type VacuumDef = { name: string; areas: string[] };

export type AudioAreaDef = { area: string; speakers: string[] };
export type AudioRoster = { everywhere: string | null; areas: AudioAreaDef[] };

/**
 * Generic parent blocks (18 Jul brief) — the Workshop's composable tier.
 * A block is DATA: one or more Notion sources merged into one sorted list,
 * each source wearing a VDS accent colour, properties chosen PER SOURCE
 * (two databases rarely share field names; Steff's never will). Bespoke
 * blocks (Projects, Notion finder, Calendar) are code and stay code.
 */
export const VDS_ACCENTS = ["teal", "bronze", "sage", "amber", "red", "muted"] as const;
export type VdsAccent = (typeof VDS_ACCENTS)[number];

// The bespoke tool names — a generic block can't shadow one in the tool bar.
const RESERVED_BLOCK_NAMES = new Set(["notion", "calendar", "projects"]);

export type BlockSource = {
	data_source_id: string;
	accent: VdsAccent;
	/** Property NAMES to show, in order. Title always renders; never listed. */
	properties: string[];
};

export type WorkshopBlock = {
	name: string;
	icon: string;
	sources: BlockSource[];
	sort: { property: string; direction: "asc" | "desc" };
};

export type WorkshopMappings = {
	journal_ds: string;
	projects_db: string;
	projects_ds: string;
	jayhq_page: string;
	snugglezone_page: string;
	tasks_ds: string;
};

export const MAPPING_KEYS: Array<keyof WorkshopMappings> = [
	"journal_ds",
	"projects_db",
	"projects_ds",
	"jayhq_page",
	"snugglezone_page",
	"tasks_ds",
];

const ID_SHAPE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Validate a candidate Hearth registry. Exported for the PUT route + tests. */
export function validateHearthRegistry(
	value: unknown,
): { ok: true; registry: HearthRegistry } | { ok: false; error: string } {
	const v = value as Partial<HearthRegistry> | null;
	if (!v || typeof v !== "object") return { ok: false, error: "registry must be an object" };
	const lights = Array.isArray(v.scene_lights)
		? v.scene_lights.map((l) => String(l).trim()).filter(Boolean)
		: [];
	if (lights.length === 0 || lights.length > 10) {
		return { ok: false, error: "scene_lights needs 1-10 light names" };
	}
	if (new Set(lights).size !== lights.length) {
		return { ok: false, error: "scene_lights has a duplicate name" };
	}
	if (!Array.isArray(v.scenes) || v.scenes.length === 0 || v.scenes.length > 12) {
		return { ok: false, error: "scenes needs 1-12 entries" };
	}
	const scenes: SceneDef[] = [];
	const seenNames = new Set<string>();
	for (const raw of v.scenes as Array<Partial<SceneDef>>) {
		const name = typeof raw?.name === "string" ? raw.name.trim() : "";
		if (!name || name.length > 24) {
			return { ok: false, error: "every scene needs a name (1-24 chars)" };
		}
		if (seenNames.has(name.toLowerCase())) {
			return { ok: false, error: `scene name "${name}" appears twice` };
		}
		seenNames.add(name.toLowerCase());
		const icon =
			typeof raw?.icon === "string" && /^ti-[a-z0-9-]+$/.test(raw.icon.trim())
				? raw.icon.trim()
				: "ti-bulb";
		const vals = raw?.values;
		if (!Array.isArray(vals) || vals.length !== lights.length) {
			return {
				ok: false,
				error: `scene "${name}" needs exactly ${lights.length} values — one per scene light, in order`,
			};
		}
		const nums = vals.map(Number);
		if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 100)) {
			return { ok: false, error: `scene "${name}" values must be 0-100` };
		}
		scenes.push({ name, icon, values: nums });
	}
	const gLight = typeof v.goodnight?.light === "string" ? v.goodnight.light.trim() : "";
	const gPct = Number(v.goodnight?.brightness);
	if (!gLight) return { ok: false, error: "goodnight.light is required" };
	if (!Number.isFinite(gPct) || gPct < 0 || gPct > 100) {
		return { ok: false, error: "goodnight.brightness must be 0-100" };
	}
	return {
		ok: true,
		registry: { scene_lights: lights, scenes, goodnight: { light: gLight, brightness: gPct } },
	};
}

/** Validate a candidate vacuum roster. Exported for the PUT route + tests. */
export function validateVacuumRoster(
	value: unknown,
): { ok: true; vacuums: VacuumDef[] } | { ok: false; error: string } {
	if (!Array.isArray(value) || value.length === 0 || value.length > 4) {
		return { ok: false, error: "vacuums needs 1-4 entries" };
	}
	const vacuums: VacuumDef[] = [];
	const seenNames = new Set<string>();
	for (const raw of value as Array<Partial<VacuumDef>>) {
		const name = typeof raw?.name === "string" ? raw.name.trim() : "";
		if (!name || name.length > 40) {
			return { ok: false, error: "every vacuum needs a name (1-40 chars)" };
		}
		if (seenNames.has(name.toLowerCase())) {
			return { ok: false, error: `vacuum "${name}" appears twice` };
		}
		seenNames.add(name.toLowerCase());
		const rawAreas = Array.isArray(raw?.areas) ? raw.areas : [];
		if (rawAreas.length > 16) {
			return { ok: false, error: `vacuum "${name}" has more than 16 areas` };
		}
		const areas: string[] = [];
		const seenAreas = new Set<string>();
		for (const a of rawAreas) {
			const area = String(a).trim();
			if (!area || area.length > 32) {
				return { ok: false, error: `vacuum "${name}" has an empty or over-long area name` };
			}
			if (seenAreas.has(area.toLowerCase())) {
				return { ok: false, error: `vacuum "${name}" lists "${area}" twice` };
			}
			seenAreas.add(area.toLowerCase());
			areas.push(area);
		}
		vacuums.push({ name, areas });
	}
	return { ok: true, vacuums };
}

/** Validate a candidate audio roster. Exported for the PUT route + tests. */
export function validateAudioRoster(
	value: unknown,
): { ok: true; audio: AudioRoster } | { ok: false; error: string } {
	const v = value as Partial<AudioRoster> | null;
	if (!v || typeof v !== "object" || Array.isArray(v)) {
		return { ok: false, error: "audio roster must be an object" };
	}
	let everywhere: string | null = null;
	if (v.everywhere !== null && v.everywhere !== undefined) {
		const e = typeof v.everywhere === "string" ? v.everywhere.trim() : "";
		if (!e || e.length > 40) {
			return { ok: false, error: "everywhere must be a player name (1-40 chars) or null" };
		}
		everywhere = e;
	}
	if (!Array.isArray(v.areas) || v.areas.length > 12) {
		return { ok: false, error: "audio.areas needs 0-12 entries" };
	}
	const areas: AudioAreaDef[] = [];
	const seenAreas = new Set<string>();
	const seenSpeakers = new Set<string>();
	for (const raw of v.areas as Array<Partial<AudioAreaDef>>) {
		const area = typeof raw?.area === "string" ? raw.area.trim() : "";
		if (!area || area.length > 32) {
			return { ok: false, error: "every audio area needs a name (1-32 chars)" };
		}
		if (seenAreas.has(area.toLowerCase())) {
			return { ok: false, error: `audio area "${area}" appears twice` };
		}
		seenAreas.add(area.toLowerCase());
		const rawSpeakers = Array.isArray(raw?.speakers) ? raw.speakers : [];
		if (rawSpeakers.length === 0 || rawSpeakers.length > 8) {
			return { ok: false, error: `audio area "${area}" needs 1-8 speakers` };
		}
		const speakers: string[] = [];
		for (const s of rawSpeakers) {
			const speaker = String(s).trim();
			if (!speaker || speaker.length > 40) {
				return { ok: false, error: `audio area "${area}" has an empty or over-long speaker name` };
			}
			// One speaker lives in one area (HA's model), and the Everywhere
			// group is never inside an area — it IS the whole-house group.
			if (seenSpeakers.has(speaker.toLowerCase())) {
				return { ok: false, error: `speaker "${speaker}" appears in two areas` };
			}
			if (everywhere && speaker.toLowerCase() === everywhere.toLowerCase()) {
				return { ok: false, error: `"${speaker}" is the Everywhere group — it can't also sit in an area` };
			}
			seenSpeakers.add(speaker.toLowerCase());
			speakers.push(speaker);
		}
		areas.push({ area, speakers });
	}
	return { ok: true, audio: { everywhere, areas } };
}

/** Validate a candidate workshop.blocks array. Exported for the PUT route + tests. */
export function validateWorkshopBlocks(
	value: unknown,
): { ok: true; blocks: WorkshopBlock[] } | { ok: false; error: string } {
	if (!Array.isArray(value) || value.length > 8) {
		return { ok: false, error: "blocks must be an array of 0-8 entries" };
	}
	const blocks: WorkshopBlock[] = [];
	const seenNames = new Set<string>();
	for (const raw of value as Array<Partial<WorkshopBlock>>) {
		const name = typeof raw?.name === "string" ? raw.name.trim() : "";
		if (!name || name.length > 24) {
			return { ok: false, error: "every block needs a name (1-24 chars)" };
		}
		if (RESERVED_BLOCK_NAMES.has(name.toLowerCase())) {
			return { ok: false, error: `"${name}" is a bespoke tool — pick another block name` };
		}
		if (seenNames.has(name.toLowerCase())) {
			return { ok: false, error: `block name "${name}" appears twice` };
		}
		seenNames.add(name.toLowerCase());
		const icon =
			typeof raw?.icon === "string" && /^ti-[a-z0-9-]+$/.test(raw.icon.trim())
				? raw.icon.trim()
				: "ti-database";
		if (!Array.isArray(raw?.sources) || raw.sources.length === 0 || raw.sources.length > 4) {
			return { ok: false, error: `block "${name}" needs 1-4 sources` };
		}
		const sources: BlockSource[] = [];
		const seenSources = new Set<string>();
		for (const s of raw.sources as Array<Partial<BlockSource>>) {
			const id = typeof s?.data_source_id === "string" ? s.data_source_id.trim() : "";
			if (!ID_SHAPE.test(id)) {
				return { ok: false, error: `block "${name}" has a source that isn't a Notion id` };
			}
			if (seenSources.has(id)) {
				return { ok: false, error: `block "${name}" lists the same source twice` };
			}
			seenSources.add(id);
			// The design system is the guardrail: named VDS accents only, no hex.
			const accent = s?.accent as VdsAccent;
			if (!VDS_ACCENTS.includes(accent)) {
				return {
					ok: false,
					error: `block "${name}": accent must be one of ${VDS_ACCENTS.join(", ")}`,
				};
			}
			const rawProps = Array.isArray(s?.properties) ? s.properties : [];
			if (rawProps.length > 8) {
				return { ok: false, error: `block "${name}" shows more than 8 properties for one source` };
			}
			const properties: string[] = [];
			const seenProps = new Set<string>();
			for (const p of rawProps) {
				const prop = String(p).trim();
				if (!prop || prop.length > 64) {
					return { ok: false, error: `block "${name}" has an empty or over-long property name` };
				}
				if (seenProps.has(prop)) {
					return { ok: false, error: `block "${name}" lists property "${prop}" twice` };
				}
				seenProps.add(prop);
				properties.push(prop);
			}
			sources.push({ data_source_id: id, accent, properties });
		}
		const sortProp =
			typeof raw?.sort?.property === "string" && raw.sort.property.trim()
				? raw.sort.property.trim()
				: "title";
		const direction = raw?.sort?.direction === "desc" ? "desc" : "asc";
		blocks.push({ name, icon, sources, sort: { property: sortProp, direction } });
	}
	return { ok: true, blocks };
}

/** Validate candidate Workshop mappings. Exported for the PUT route + tests. */
export function validateWorkshopMappings(
	value: unknown,
): { ok: true; mappings: WorkshopMappings } | { ok: false; error: string } {
	const v = value as Record<string, unknown> | null;
	if (!v || typeof v !== "object") return { ok: false, error: "mappings must be an object" };
	const out = {} as WorkshopMappings;
	for (const key of MAPPING_KEYS) {
		const id = typeof v[key] === "string" ? (v[key] as string).trim() : "";
		if (!ID_SHAPE.test(id)) {
			return { ok: false, error: `${key} must be a Notion id (uuid, dashes optional)` };
		}
		out[key] = id;
	}
	return { ok: true, mappings: out };
}

function db(env: Env): SupabaseClient {
	return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
		auth: { persistSession: false, autoRefreshToken: false },
	});
}

async function loadPreference(env: Env, key: string): Promise<unknown> {
	const { data, error } = await db(env)
		.from("preferences")
		.select("value")
		.eq("key", key)
		.maybeSingle();
	if (error) throw new Error(`${key} load failed: ${error.message}`);
	if (!data?.value) {
		throw new Error(`${key} is missing — open the Fuse Box and set it (seeded by migration; it should exist)`);
	}
	return data.value;
}

export async function loadHearthRegistry(env: Env): Promise<HearthRegistry> {
	const raw = await loadPreference(env, "hearth.registry");
	const valid = validateHearthRegistry(raw);
	if (!valid.ok) throw new Error(`hearth.registry is invalid: ${valid.error}`);
	return valid.registry;
}

export async function loadVacuumRoster(env: Env): Promise<VacuumDef[]> {
	const raw = await loadPreference(env, "hearth.vacuums");
	const valid = validateVacuumRoster(raw);
	if (!valid.ok) throw new Error(`hearth.vacuums is invalid: ${valid.error}`);
	return valid.vacuums;
}

export async function loadAudioRoster(env: Env): Promise<AudioRoster> {
	const raw = await loadPreference(env, "hearth.audio");
	const valid = validateAudioRoster(raw);
	if (!valid.ok) throw new Error(`hearth.audio is invalid: ${valid.error}`);
	return valid.audio;
}

export async function loadWorkshopMappings(env: Env): Promise<WorkshopMappings> {
	const raw = await loadPreference(env, "workshop.mappings");
	const valid = validateWorkshopMappings(raw);
	if (!valid.ok) throw new Error(`workshop.mappings is invalid: ${valid.error}`);
	return valid.mappings;
}

export async function loadWorkshopBlocks(env: Env): Promise<WorkshopBlock[]> {
	const raw = await loadPreference(env, "workshop.blocks");
	const valid = validateWorkshopBlocks(raw);
	if (!valid.ok) throw new Error(`workshop.blocks is invalid: ${valid.error}`);
	return valid.blocks;
}
