/**
 * Vale OS — the Hearth's backend: house state + controls, all on the MCP rail.
 *
 * The room half of the HA vertical (the ha_* registry entries are the brain
 * half). Everything here goes through callMcpTool against the ONE HA server
 * config (mcp.ts haServer) — no second client, no second config, per the brief.
 *
 * The read: GetLiveContext returns a YAML-ish text blob (probed 4 Jul 2026 —
 * it DOES carry brightness, as '0'–'255' strings, and media volume_level as a
 * 0–1 float). parseLiveContext() turns that into the tiles' shape: lights with
 * on/off + brightness %, the vacuum's state, media players with volume %. Short
 * in-Worker cache + last-good on a failed refresh (weather.ts discipline);
 * every control busts the cache so the tile's follow-up read shows truth.
 *
 * The writes: each maps to one HA intent (HassTurnOn/Off, HassLightSet,
 * HassVacuum*, HassMedia*, HassSetVolume). All are explicit Elle-initiated
 * actions fired by the panel — nothing here runs on its own. Controls THROW on
 * failure (spotify.ts convention); the routes net them into a clean
 * { ok: false } so the panel never shows a fake success.
 */

import { callMcpTool, haServer } from "./mcp";
import { loadHearthRegistry } from "./config";

// ── The normalised house state (the /api/home payload) ───────────────────────

export type HomeLight = {
	name: string;
	area: string | null;
	on: boolean;
	/** 0–100. 0 when off. */
	brightness: number;
};

export type HomeMedia = {
	name: string;
	area: string | null;
	/** HA state verbatim: idle | playing | paused | unavailable | … */
	state: string;
	/** 0–100, or null when HA doesn't report one. */
	volume: number | null;
	/** From HA's device_class — lets the tile pick an icon without knowing names. */
	kind: "tv" | "speaker";
};

export type HomeVacuum = { name: string; state: string };

export type HomeState = {
	lights: HomeLight[];
	/** Every exposed vacuum — the roster decides which render and with what chips. */
	vacuums: HomeVacuum[];
	media: HomeMedia[];
};

// ── GetLiveContext text → entities ───────────────────────────────────────────

type RawEntity = {
	name: string;
	domain: string;
	state: string;
	area: string | null;
	attrs: Record<string, string>;
};

const unquote = (v: string) => v.trim().replace(/^'(.*)'$/, "$1").trim();

/**
 * Parse the live-context blob. Shape (one entity per "- names:" block):
 *   - names: Kitchen Light Bar
 *     domain: light
 *     state: 'on'
 *     areas: Kitchen
 *     attributes:
 *       brightness: '102'
 * Tolerant by construction: unknown keys are ignored, a malformed block just
 * contributes less — the panel would rather show a thinner house than error.
 */
export function parseLiveContext(text: string): RawEntity[] {
	const out: RawEntity[] = [];
	let cur: RawEntity | null = null;
	let inAttrs = false;
	for (const line of text.split("\n")) {
		const head = /^- names:\s*(.*)$/.exec(line);
		if (head) {
			if (cur) out.push(cur);
			cur = { name: unquote(head[1]), domain: "", state: "", area: null, attrs: {} };
			inAttrs = false;
			continue;
		}
		if (!cur) continue;
		const attr = /^ {4}(\w+):\s*(.*)$/.exec(line);
		if (inAttrs && attr) {
			const v = unquote(attr[2]);
			if (v) cur.attrs[attr[1]] = v;
			continue;
		}
		const kv = /^ {2}(\w+):\s*(.*)$/.exec(line);
		if (kv) {
			const v = unquote(kv[2]);
			if (kv[1] === "attributes") {
				inAttrs = true;
			} else {
				inAttrs = false;
				if (kv[1] === "domain") cur.domain = v;
				else if (kv[1] === "state") cur.state = v;
				else if (kv[1] === "areas") cur.area = v || null;
			}
		}
	}
	if (cur) out.push(cur);
	return out;
}

// HA reports light brightness 0–255; the panel speaks 0–100.
const toPercent = (raw: string | undefined, on: boolean): number => {
	const n = Number(raw);
	if (Number.isFinite(n) && raw !== undefined) return Math.round((n / 255) * 100);
	return on ? 100 : 0; // on with no reading — show full rather than a lying 0
};

export function normaliseHome(entities: RawEntity[]): HomeState {
	const lights: HomeLight[] = entities
		.filter((e) => e.domain === "light")
		.map((e) => {
			const on = e.state === "on";
			return { name: e.name, area: e.area, on, brightness: on ? toPercent(e.attrs.brightness, on) : 0 };
		});

	const vacuums: HomeVacuum[] = entities
		.filter((e) => e.domain === "vacuum")
		.map((e) => ({ name: e.name, state: e.state }));

	// Media: "This Device" is the HA companion shell, not a house device — drop
	// it. The Living Room TV comes through twice (probed); dedupe by name,
	// merging what each entry knows (one carries volume, one device_class).
	const media: HomeMedia[] = [];
	for (const e of entities.filter(
		(e) => e.domain === "media_player" && e.name !== "This Device",
	)) {
		const vol = e.attrs.volume_level !== undefined ? Number(e.attrs.volume_level) : NaN;
		const row: HomeMedia = {
			name: e.name,
			area: e.area,
			state: e.state,
			volume: Number.isFinite(vol) ? Math.round(vol * 100) : null,
			kind: e.attrs.device_class === "tv" ? "tv" : "speaker",
		};
		const seen = media.findIndex((m) => m.name === e.name);
		if (seen === -1) media.push(row);
		else {
			media[seen] = {
				...media[seen],
				volume: media[seen].volume ?? row.volume,
				kind: media[seen].kind === "tv" || row.kind === "tv" ? "tv" : "speaker",
			};
		}
	}

	return { lights, vacuums, media };
}

// ── The read: short cache + last-good (weather.ts discipline) ────────────────

const HOME_TTL_MS = 30_000;
let homeCache: { at: number; data: HomeState } | null = null;

/** Controls call this so the panel's follow-up read shows the true result. */
export function bustHomeCache(): void {
	homeCache = null;
}

async function readHome(env: Env): Promise<HomeState> {
	const r = await callMcpTool(await haServer(env), "GetLiveContext", {});
	if (r.is_error) throw new Error(r.content);
	// The tool text wraps a JSON envelope around the YAML-ish blob sometimes
	// ({"success": true, "result": "Live Context: …"}) — unwrap if so.
	let text = r.content;
	try {
		const parsed = JSON.parse(text) as { result?: string };
		if (typeof parsed.result === "string") text = parsed.result;
	} catch {
		/* already plain text */
	}
	return normaliseHome(parseLiveContext(text));
}

export async function getHomeCached(env: Env): Promise<HomeState> {
	const now = Date.now();
	if (homeCache && now - homeCache.at < HOME_TTL_MS) return homeCache.data;
	try {
		const data = await readHome(env);
		homeCache = { at: now, data };
		return data;
	} catch (err) {
		if (homeCache) return homeCache.data; // last-good beats a blank panel
		throw err;
	}
}

// ── Controls (throw on failure; the routes net them) ─────────────────────────

// One HA intent call. Success busts the read cache; failure throws with the
// rail's message so the route reports the truth.
async function ha(env: Env, tool: string, args: Record<string, unknown>): Promise<void> {
	const r = await callMcpTool(await haServer(env), tool, args);
	if (r.is_error) throw new Error(r.content);
	bustHomeCache();
}

export async function setLight(env: Env, name: string, brightness: number): Promise<void> {
	// HassLightSet treats 0 as off, so one intent covers the dimmer's whole range.
	await ha(env, "HassLightSet", { name, brightness: Math.max(0, Math.min(100, brightness)) });
}

export async function lightOnOff(env: Env, name: string, on: boolean): Promise<void> {
	await ha(env, on ? "HassTurnOn" : "HassTurnOff", { name, domain: ["light"] });
}

// The scene presets — WAS three hardcoded constants (Elle's 4 Jul values),
// NOW the hearth.registry config row, edited in the Fuse Box (Phase 6) and
// loaded per call so a registry edit drives the very next scene tap. A scene
// is still just N HassLightSet calls, applied to the registry's lights by
// their REAL HA names, in order; no HA scene entities exist (yet).
export async function setScene(env: Env, scene: string): Promise<void> {
	const registry = await loadHearthRegistry(env);
	const def = registry.scenes.find((s) => s.name === scene);
	if (!def) throw new Error(`Unknown scene "${scene}".`);
	const results = await Promise.allSettled(
		registry.scene_lights.map((name, i) => setLight(env, name, def.values[i])),
	);
	const failed = results.filter((r) => r.status === "rejected");
	if (failed.length) {
		throw new Error(
			`Scene "${scene}": ${failed.length} of ${registry.scene_lights.length} lights didn't take.`,
		);
	}
}

/** Everything off — one intent, every light. */
export async function allLightsOff(env: Env): Promise<void> {
	await ha(env, "HassTurnOff", { domain: ["light"] });
}

/**
 * Goodnight — everything off EXCEPT the registry's path-to-bed light at its
 * configured brightness (was: Bedroom at 20%, Elle's 4 Jul ruling, now the
 * hearth.registry seed values), and any playing media paused. Sequential on
 * purpose: all-off first, then the bedroom light comes back dim. Media
 * pauses are best-effort — a stubborn Echo doesn't fail the ritual.
 */
export async function goodnight(env: Env): Promise<void> {
	const registry = await loadHearthRegistry(env);
	const before = await getHomeCached(env).catch(() => null);
	await allLightsOff(env);
	await setLight(env, registry.goodnight.light, registry.goodnight.brightness);
	const playing = (before?.media ?? []).filter((m) => m.state === "playing");
	await Promise.allSettled(playing.map((m) => ha(env, "HassMediaPause", { name: m.name })));
}

export async function vacuumAction(
	env: Env,
	action: string,
	area?: string,
	name?: string,
): Promise<void> {
	// name targets one vacuum when the roster holds several; omitted, the
	// intent falls back to its own matching (the one-vacuum house, unchanged).
	const who = name ? { name } : {};
	if (action === "clean") return ha(env, "HassVacuumStart", { ...who });
	if (action === "dock") return ha(env, "HassVacuumReturnToBase", { ...who });
	if (action === "clean_area") {
		if (!area) throw new Error("clean_area needs an area.");
		return ha(env, "HassVacuumCleanArea", { area, ...who });
	}
	throw new Error(`Unknown vacuum action "${action}".`);
}

// ── The area oracle (verified live, 18 Jul) ─────────────────────────────────
//
// HA doesn't expose which areas a vacuum can clean, and the rail can only
// *list* areas that contain an exposed entity — so the vacuum roster's areas
// are typed into the Fuse Box. This checks a typed name against the ONE
// side-effect-free probe the rail offers: GetLiveContext's area filter, which
// answers differently for a bad name vs a real-but-empty area:
//   "Area 'Narnia' does not exist"            → invalid
//   "No exposed entities found in area 'Study'" → valid (exists, just empty)
//   success (entities listed)                  → valid
// A rail failure THROWS — "couldn't check" must never present as "invalid".

/** Interpret a GetLiveContext area-filter response. Exported for tests. */
export function interpretAreaProbe(raw: string): { valid: boolean; reason: string | null } {
	let parsed: { success?: boolean; error?: string };
	try {
		parsed = JSON.parse(raw) as { success?: boolean; error?: string };
	} catch {
		// Plain text back = the filter matched and HA answered with the blob.
		return { valid: true, reason: null };
	}
	if (parsed.success === false && typeof parsed.error === "string") {
		if (/does not exist/i.test(parsed.error)) return { valid: false, reason: parsed.error };
		if (/no exposed entities/i.test(parsed.error)) return { valid: true, reason: parsed.error };
		throw new Error(`Area check got an answer it doesn't recognise: ${parsed.error}`);
	}
	return { valid: true, reason: null };
}

export async function validateArea(
	env: Env,
	area: string,
): Promise<{ valid: boolean; reason: string | null }> {
	const r = await callMcpTool(await haServer(env), "GetLiveContext", { area });
	if (r.is_error) throw new Error(r.content);
	return interpretAreaProbe(r.content);
}

export async function mediaAction(
	env: Env,
	name: string,
	action: string,
	level?: number,
): Promise<void> {
	if (action === "pause") return ha(env, "HassMediaPause", { name });
	if (action === "play") return ha(env, "HassMediaUnpause", { name });
	if (action === "volume") {
		if (typeof level !== "number" || !Number.isFinite(level)) {
			throw new Error("volume needs a level (0–100).");
		}
		return ha(env, "HassSetVolume", {
			name,
			volume_level: Math.max(0, Math.min(100, Math.round(level))),
		});
	}
	throw new Error(`Unknown media action "${action}".`);
}
