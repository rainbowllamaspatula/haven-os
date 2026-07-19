/**
 * Weather reader — live, read-only current conditions from Open-Meteo.
 *
 * The ambient bar's weather tile's one source. Same family as projects.ts and
 * notion.ts: a thin live read behind a short in-Worker cache, last-good on a
 * failed fetch rather than a blank tile.
 *
 * Deliberately NOT a cron/mirror (the build brief's locked shape): the location
 * is dynamic — device GPS first, Cloudflare IP geo as fallback — so a
 * server-side cron can't pre-fetch a place it doesn't yet know. That's what
 * pushes weather onto the lighter Projects-style live-read pattern rather than
 * the calendar-sync mirror pattern.
 *
 * Open-Meteo is keyless and free for non-commercial / personal use under
 * CC-BY 4.0, so there's no secret and no binding to add — the same reason the
 * place label's reverse-geocode is done client-side, keyless, in the front end.
 *
 * Read-only: this only ever GETs Open-Meteo. Nothing is written anywhere.
 */

import { fetchWithTimeout } from "./http";

const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";

// WMO weather-interpretation code → a short, tile-sized condition word. Named
// and grouped so it's easy to retune — the same one-function-lookup spirit as
// the calendar spine colours. Codes follow Open-Meteo's published WMO table;
// nearby codes collapse to one word because the tile has room for a word, not a
// taxonomy (e.g. all drizzle intensities → "drizzle").
const CONDITION_BY_CODE: Record<number, string> = {
	0: "clear",
	1: "clear", // mainly clear
	2: "partly cloudy",
	3: "cloudy", // overcast
	45: "fog",
	48: "fog", // depositing rime fog
	51: "drizzle",
	53: "drizzle",
	55: "drizzle",
	56: "drizzle", // freezing drizzle
	57: "drizzle",
	61: "rain",
	63: "rain",
	65: "rain",
	66: "rain", // freezing rain
	67: "rain",
	71: "snow",
	73: "snow",
	75: "snow",
	77: "snow", // snow grains
	80: "showers",
	81: "showers",
	82: "showers",
	85: "snow", // snow showers
	86: "snow",
	95: "storm", // thunderstorm
	96: "storm", // thunderstorm with hail
	99: "storm",
};

// An unknown code degrades to a neutral dash rather than a wrong word.
function conditionFor(code: number): string {
	return CONDITION_BY_CODE[code] ?? "—";
}

// What the tile needs: a rounded temperature and a condition word. The place
// LABEL is assembled elsewhere (client-side on the device path, request.cf.city
// on the IP fallback) — this reader is purely the number and the word, keyed by
// coordinates, so it's shared cleanly by both location paths.
export type WeatherReading = { temp: number; condition: string };

// ~15 min freshness, keyed by coords rounded to ~2 dp so small movement reuses
// the cache while travelling busts it. In-Worker (per-isolate) and best-effort,
// the same discipline as projects.ts — just a Map instead of one slot, because
// weather varies by place. Bounded so a long-lived isolate that sees many
// coordinates (travelling) can't grow it without limit.
const WEATHER_CACHE_TTL_MS = 15 * 60 * 1000;
const WEATHER_CACHE_MAX = 50;
const weatherCache = new Map<string, { at: number; data: WeatherReading }>();

function coordKey(lat: number, lon: number): string {
	return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

/**
 * Current conditions for a coordinate, live (cached ~15 min). On a failed read,
 * serve last-good for that coordinate rather than blanking; only a failure with
 * no last-good throws, so the route can surface it.
 */
export async function getWeather(lat: number, lon: number): Promise<WeatherReading> {
	const key = coordKey(lat, lon);
	const now = Date.now();
	const hit = weatherCache.get(key);
	if (hit && now - hit.at < WEATHER_CACHE_TTL_MS) return hit.data;

	try {
		const url = `${OPEN_METEO}?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`;
		const res = await fetchWithTimeout(url, {}, { service: "openmeteo" });
		if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${await res.text()}`);

		const body = (await res.json()) as {
			current?: { temperature_2m?: number; weather_code?: number };
		};
		const t = body.current?.temperature_2m;
		const code = body.current?.weather_code;
		if (typeof t !== "number" || typeof code !== "number") {
			throw new Error("Open-Meteo: missing current.temperature_2m / weather_code");
		}

		const data: WeatherReading = { temp: Math.round(t), condition: conditionFor(code) };

		// Evict the oldest entry once the map is full — travelling churns keys, so
		// this keeps the cache from growing unbounded across a long-lived isolate.
		if (!weatherCache.has(key) && weatherCache.size >= WEATHER_CACHE_MAX) {
			const oldest = weatherCache.keys().next().value;
			if (oldest !== undefined) weatherCache.delete(oldest);
		}
		weatherCache.set(key, { at: now, data });
		return data;
	} catch (err) {
		if (hit) return hit.data; // last-good beats a blank tile
		throw err;
	}
}
