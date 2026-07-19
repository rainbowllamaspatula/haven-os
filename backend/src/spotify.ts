/**
 * Vale OS — native Spotify control.
 *
 * The brain's hands on Elle's music, wrapped inside the house: same family as
 * notion.ts (a thin live API helper the registry's tools call), plus the one
 * thing Notion never needed — OAuth. Spotify access tokens live ~an hour and
 * are minted from a long-lived refresh token; the flow here is lifted from
 * Elle's existing Spotify MCP (Jay Files/Code Projects/Spotify-MCP), whose
 * credentials already carry the playback scopes, so we reuse that app rather
 * than registering a new one.
 *
 * Secrets (Elle sets them, never committed): SPOTIFY_CLIENT_ID,
 * SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN — declared in env.d.ts, set with
 * `wrangler secret put` (prod) / `.dev.vars` (local).
 *
 * Control only: now-playing, play/pause/skip, search, queue. No playlist
 * deletion, no library destruction — the write_memory "can't destroy" line,
 * held here too.
 *
 * Error contract: tool functions THROW; the registry's runTool converts a throw
 * into is_error so a Spotify hiccup never costs Jay a reply. The now-playing
 * READ (the ambient tile's source) instead follows the weather.ts discipline:
 * short cache, last-good on failure, a clean idle state when nothing's playing.
 */

import { fetchWithTimeout } from "./http";

const SPOTIFY_API = "https://api.spotify.com/v1";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

// ── OAuth: refresh-token → access-token, cached in-isolate ───────────────────

let tokenCache: { token: string; expiresAt: number } | null = null;
// Single-flight: concurrent cold calls share one in-flight refresh.
let refreshInFlight: Promise<string> | null = null;

async function getAccessToken(env: Env): Promise<string> {
	// 60s early-refresh margin so a token can't expire mid-call.
	if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.token;
	if (refreshInFlight) return refreshInFlight;

	refreshInFlight = (async () => {
		try {
			const res = await fetchWithTimeout(
				SPOTIFY_TOKEN_URL,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
						Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
					},
					body: new URLSearchParams({
						grant_type: "refresh_token",
						refresh_token: env.SPOTIFY_REFRESH_TOKEN,
					}),
				},
				{ service: "spotify" },
			);
			if (!res.ok) throw new Error(`Spotify token refresh → ${res.status}: ${await res.text()}`);
			const data = (await res.json()) as {
				access_token?: string;
				expires_in?: number;
				refresh_token?: string;
			};
			if (!data.access_token) throw new Error("Spotify token refresh returned no access_token.");
			// Spotify doesn't normally rotate refresh tokens on this flow; if it ever
			// does, a Worker can't update its own secret — say so loudly in the tail.
			if (data.refresh_token) {
				console.log("Spotify returned a NEW refresh token — update the SPOTIFY_REFRESH_TOKEN secret.");
			}
			tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
			return tokenCache.token;
		} finally {
			refreshInFlight = null;
		}
	})();
	return refreshInFlight;
}

// ── The API call ─────────────────────────────────────────────────────────────

/**
 * One Spotify Web API call. Returns the parsed JSON, or null for the empty
 * responses the player endpoints use (204 = "done" / "nothing playing").
 * A 401 busts the token cache and retries once; NO_ACTIVE_DEVICE becomes a
 * message Jay can actually relay.
 */
async function spotifyFetch(
	env: Env,
	path: string,
	init?: { method?: string; body?: unknown },
): Promise<unknown | null> {
	const method = init?.method ?? "GET";
	const doFetch = async () =>
		fetchWithTimeout(
			`${SPOTIFY_API}/${path}`,
			{
				method,
				headers: {
					Authorization: `Bearer ${await getAccessToken(env)}`,
					"Content-Type": "application/json",
				},
				...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
			},
			{ service: "spotify" },
		);

	let res = await doFetch();
	if (res.status === 401) {
		tokenCache = null;
		res = await doFetch();
	}
	if (res.status === 204) return null;
	const text = await res.text();
	if (!res.ok) {
		if (res.status === 404 && /NO_ACTIVE_DEVICE/i.test(text)) {
			throw new Error(
				"No active Spotify device — Spotify needs to be open (phone, desktop, anywhere) before playback can be controlled.",
			);
		}
		throw new Error(`Spotify ${method} /${path} → ${res.status}: ${text}`);
	}
	// The control endpoints usually 204, but sometimes 200 with a junk non-JSON
	// body from Spotify's gateway (seen live on /me/player/next, 2 Jul 2026: a
	// 200 whose body wasn't JSON, after the skip had already succeeded). The
	// action succeeded either way — only parse when Spotify SAYS it's JSON.
	if (!text || !(res.headers.get("content-type") ?? "").includes("application/json")) {
		return null;
	}
	return JSON.parse(text);
}

// ── Now playing (shared by the tool and the ambient tile route) ──────────────

export type NowPlaying = {
	playing: boolean;
	track: string | null;
	artist: string | null;
	album: string | null;
	/** Smallest album-art image URL — tile-sized. */
	art: string | null;
	/** Largest album-art image URL — the Listening Room hero. */
	art_large: string | null;
	// ── Listening Room extensions (4 Jul) — the ambient tile ignores these ──
	progress_ms: number | null;
	duration_ms: number | null;
	shuffle: boolean;
	repeat: "off" | "context" | "track";
	/** Active device volume 0–100, or null when Spotify doesn't report one. */
	volume: number | null;
	/** Active device name, or null — the room's clean no-device state keys off this. */
	device: string | null;
	/** Epoch ms when Spotify was actually read — the client interpolates progress from here. */
	at: number;
};

const idle = (): NowPlaying => ({
	playing: false,
	track: null,
	artist: null,
	album: null,
	art: null,
	art_large: null,
	progress_ms: null,
	duration_ms: null,
	shuffle: false,
	repeat: "off",
	volume: null,
	device: null,
	at: Date.now(),
});

type SpotifyTrack = {
	name?: string;
	artists?: { name?: string }[];
	album?: { name?: string; images?: { url?: string }[] };
	show?: { name?: string; publisher?: string; images?: { url?: string }[] };
	uri?: string;
	duration_ms?: number;
};

// The full player-state response (/me/player) — a superset of what
// currently-playing returned, carrying the Listening Room's extras.
type PlayerState = {
	is_playing?: boolean;
	item?: SpotifyTrack | null;
	progress_ms?: number;
	shuffle_state?: boolean;
	repeat_state?: string;
	device?: { name?: string; volume_percent?: number };
};

/**
 * The current playback state, live — read from /me/player so one path carries
 * both the ambient tile's fields and the Listening Room hero's (progress,
 * shuffle/repeat, volume, device). Nothing playing / no device → clean idle.
 */
export async function getNowPlaying(env: Env): Promise<NowPlaying> {
	const data = (await spotifyFetch(
		env,
		"me/player?additional_types=track,episode",
	)) as PlayerState | null;
	const item = data?.item;
	if (!item) return idle();
	// Podcast episodes carry show instead of artists/album — fold them in rather
	// than blanking the tile on a podcast.
	const images = item.album?.images ?? item.show?.images ?? [];
	return {
		playing: data.is_playing === true,
		track: item.name ?? null,
		artist:
			(item.artists ?? []).map((a) => a.name).filter(Boolean).join(", ") ||
			item.show?.publisher ||
			item.show?.name ||
			null,
		album: item.album?.name ?? item.show?.name ?? null,
		art: images.length ? (images[images.length - 1]?.url ?? null) : null,
		art_large: images.length ? (images[0]?.url ?? null) : null,
		progress_ms: typeof data.progress_ms === "number" ? data.progress_ms : null,
		duration_ms: typeof item.duration_ms === "number" ? item.duration_ms : null,
		shuffle: data.shuffle_state === true,
		repeat:
			data.repeat_state === "context" || data.repeat_state === "track"
				? data.repeat_state
				: "off",
		volume:
			typeof data.device?.volume_percent === "number" ? data.device.volume_percent : null,
		device: data.device?.name ?? null,
		at: Date.now(),
	};
}

// The tile's read: short cache (a track changes in minutes, not seconds) +
// last-good on failure, same discipline as weather.ts. The route never blanks.
const NOW_PLAYING_TTL_MS = 15_000;
let nowPlayingCache: { at: number; data: NowPlaying } | null = null;

/**
 * The Listening Room's transport routes call this after a successful control
 * so the follow-up read shows truth, not a ≤15s-old snapshot — the Hearth's
 * read-after-write lesson, applied here on day one.
 */
export function bustNowPlayingCache(): void {
	nowPlayingCache = null;
}

export async function getNowPlayingCached(env: Env): Promise<NowPlaying> {
	const now = Date.now();
	if (nowPlayingCache && now - nowPlayingCache.at < NOW_PLAYING_TTL_MS) {
		return nowPlayingCache.data;
	}
	try {
		const data = await getNowPlaying(env);
		nowPlayingCache = { at: now, data };
		return data;
	} catch (err) {
		if (nowPlayingCache) return nowPlayingCache.data; // last-good beats a blank tile
		throw err;
	}
}

// ── Tool operations (throw on failure; runTool nets them) ────────────────────

/** spotify_now_playing — the state, worded for the model. */
export async function nowPlayingText(env: Env): Promise<string> {
	const np = await getNowPlaying(env);
	if (!np.track) return "Nothing is playing right now.";
	const state = np.playing ? "Playing" : "Paused";
	return `${state}: ${np.track} — ${np.artist ?? "unknown artist"}${np.album ? ` (${np.album})` : ""}`;
}

/**
 * spotify_play — resume, or start something specific. A track URI plays that
 * track; an album/playlist/artist URI plays that context.
 */
export async function play(env: Env, uri?: string): Promise<string> {
	const u = uri?.trim();
	const body = !u
		? undefined
		: u.startsWith("spotify:track:")
			? { uris: [u] }
			: { context_uri: u };
	await spotifyFetch(env, "me/player/play", { method: "PUT", body });
	return u ? `Started ${u}.` : "Resumed playback.";
}

/** spotify_pause. */
export async function pause(env: Env): Promise<string> {
	await spotifyFetch(env, "me/player/pause", { method: "PUT" });
	return "Paused.";
}

/** spotify_next / spotify_previous. */
export async function nextTrack(env: Env): Promise<string> {
	await spotifyFetch(env, "me/player/next", { method: "POST" });
	return "Skipped to the next track.";
}
export async function previousTrack(env: Env): Promise<string> {
	await spotifyFetch(env, "me/player/previous", { method: "POST" });
	return "Went back a track.";
}

export const SEARCH_TYPES = ["track", "album", "artist", "playlist"];

type SearchItem = {
	name?: string;
	uri?: string;
	artists?: { name?: string }[];
	album?: { name?: string };
	owner?: { display_name?: string };
};

/** spotify_search — top matches with the URIs play/queue need. */
export async function searchSpotify(env: Env, query: string, type?: string): Promise<string> {
	const q = query.trim();
	if (!q) throw new Error("Give me something to search for.");
	const t = type && SEARCH_TYPES.includes(type) ? type : "track";
	const data = (await spotifyFetch(
		env,
		`search?q=${encodeURIComponent(q)}&type=${t}&limit=5`,
	)) as Record<string, { items?: (SearchItem | null)[] }> | null;

	const items = (data?.[`${t}s`]?.items ?? []).filter((i): i is SearchItem => i != null);
	if (items.length === 0) return `No ${t}s found for "${q}".`;
	const lines = items.map((i) => {
		const by =
			(i.artists ?? []).map((a) => a.name).filter(Boolean).join(", ") ||
			i.owner?.display_name ||
			"";
		const album = i.album?.name ? ` (${i.album.name})` : "";
		return `- ${i.name}${by ? ` — ${by}` : ""}${album} — uri: ${i.uri}`;
	});
	return `Top ${t}s for "${q}":\n${lines.join("\n")}\nUse spotify_play (track or context) or spotify_queue (track) with a uri.`;
}

// ── Listening Room additions (4 Jul) — browse reads + deeper transport ───────
// Browse is READ-ONLY and the new controls are transport-only: the module's
// "can't destroy" line holds. Reads carry a ~60s cache + last-good (Workshop
// discipline); transport throws on failure like every control above.

export type RecentRow = {
	track: string;
	artist: string;
	uri: string;
	art: string | null;
	played_at: string;
};

type RecentItem = { played_at?: string; track?: SpotifyTrack | null };

const BROWSE_TTL_MS = 60_000;
let recentCache: { at: number; data: RecentRow[] } | null = null;

/** Recently played, newest first, deduped by track (a loop isn't a list). */
export async function getRecentlyPlayed(env: Env): Promise<RecentRow[]> {
	const now = Date.now();
	if (recentCache && now - recentCache.at < BROWSE_TTL_MS) return recentCache.data;
	try {
		const data = (await spotifyFetch(env, "me/player/recently-played?limit=40")) as {
			items?: RecentItem[];
		} | null;
		const rows: RecentRow[] = [];
		for (const item of data?.items ?? []) {
			const t = item.track;
			if (!t?.uri || !t.name) continue;
			if (rows.some((r) => r.uri === t.uri)) continue;
			const images = t.album?.images ?? [];
			rows.push({
				track: t.name,
				artist: (t.artists ?? []).map((a) => a.name).filter(Boolean).join(", "),
				uri: t.uri,
				art: images.length ? (images[images.length - 1]?.url ?? null) : null,
				played_at: item.played_at ?? "",
			});
			if (rows.length >= 20) break;
		}
		recentCache = { at: now, data: rows };
		return rows;
	} catch (err) {
		if (recentCache) return recentCache.data; // last-good beats a blank list
		throw err;
	}
}

export type PlaylistRow = {
	name: string;
	uri: string;
	/** Spotify's /me/playlists returns tracks: null these days (probed 4 Jul
	 * 2026, fields projection included) — count only when it actually says. */
	tracks: number | null;
	owner: string | null;
	art: string | null;
};

type PlaylistItem = {
	name?: string;
	uri?: string;
	tracks?: { total?: number };
	owner?: { display_name?: string };
	images?: { url?: string }[] | null;
};

let playlistsCache: { at: number; data: PlaylistRow[] } | null = null;

/** The user's playlists, Spotify's order. Read-only — browse, never touch. */
export async function getPlaylists(env: Env): Promise<PlaylistRow[]> {
	const now = Date.now();
	if (playlistsCache && now - playlistsCache.at < BROWSE_TTL_MS) return playlistsCache.data;
	try {
		const data = (await spotifyFetch(env, "me/playlists?limit=50")) as {
			items?: (PlaylistItem | null)[];
		} | null;
		const rows: PlaylistRow[] = (data?.items ?? [])
			.filter((p): p is PlaylistItem => p != null && !!p.uri && !!p.name)
			.map((p) => {
				const images = p.images ?? [];
				return {
					name: p.name!,
					uri: p.uri!,
					tracks: typeof p.tracks?.total === "number" ? p.tracks.total : null,
					owner: p.owner?.display_name ?? null,
					art: images.length ? (images[images.length - 1]?.url ?? null) : null,
				};
			});
		playlistsCache = { at: now, data: rows };
		return rows;
	} catch (err) {
		if (playlistsCache) return playlistsCache.data;
		throw err;
	}
}

export type BrowseSearchRow = {
	title: string;
	sub: string;
	uri: string;
	art: string | null;
	kind: "track" | "playlist" | "artist";
};

type SearchEntity = {
	name?: string;
	uri?: string;
	artists?: { name?: string }[];
	album?: { name?: string; images?: { url?: string }[] };
	images?: { url?: string }[] | null;
	owner?: { display_name?: string };
	tracks?: { total?: number };
};

/**
 * Structured search for the room's browse (searchSpotify above stays as the
 * BRAIN's text-shaped tool — same API call, different audience). Tracks first,
 * then playlists, then artists; every row's uri is playable via play().
 */
export async function searchBrowse(env: Env, query: string): Promise<BrowseSearchRow[]> {
	const q = query.trim();
	if (!q) return [];
	const data = (await spotifyFetch(
		env,
		`search?q=${encodeURIComponent(q)}&type=track,playlist,artist&limit=5`,
	)) as Record<string, { items?: (SearchEntity | null)[] }> | null;

	const rows: BrowseSearchRow[] = [];
	const push = (e: SearchEntity, kind: BrowseSearchRow["kind"]) => {
		if (!e.uri || !e.name) return;
		const images = e.album?.images ?? e.images ?? [];
		const art = images.length ? (images[images.length - 1]?.url ?? null) : null;
		const sub =
			kind === "track"
				? [
						(e.artists ?? []).map((a) => a.name).filter(Boolean).join(", "),
						e.album?.name,
					]
						.filter(Boolean)
						.join(" · ")
				: kind === "playlist"
					? [
							"Playlist",
							typeof e.tracks?.total === "number" ? `${e.tracks.total} tracks` : null,
							e.owner?.display_name ?? null,
						]
							.filter(Boolean)
							.join(" · ")
					: "Artist";
		rows.push({ title: e.name, sub, uri: e.uri, art, kind });
	};
	for (const t of data?.tracks?.items ?? []) if (t) push(t, "track");
	for (const p of data?.playlists?.items ?? []) if (p) push(p, "playlist");
	for (const a of data?.artists?.items ?? []) if (a) push(a, "artist");
	return rows;
}

// ── Deeper transport (Listening Room) — control-only, throw on failure ───────

export async function setShuffle(env: Env, on: boolean): Promise<void> {
	await spotifyFetch(env, `me/player/shuffle?state=${on}`, { method: "PUT" });
}

export const REPEAT_STATES = ["off", "context", "track"] as const;
export async function setRepeat(env: Env, state: string): Promise<void> {
	if (!REPEAT_STATES.includes(state as (typeof REPEAT_STATES)[number])) {
		throw new Error(`repeat must be one of: ${REPEAT_STATES.join(", ")}.`);
	}
	await spotifyFetch(env, `me/player/repeat?state=${state}`, { method: "PUT" });
}

export async function setPlayerVolume(env: Env, pct: number): Promise<void> {
	const v = Math.max(0, Math.min(100, Math.round(pct)));
	await spotifyFetch(env, `me/player/volume?volume_percent=${v}`, { method: "PUT" });
}

export async function seekTo(env: Env, positionMs: number): Promise<void> {
	const p = Math.max(0, Math.round(positionMs));
	await spotifyFetch(env, `me/player/seek?position_ms=${p}`, { method: "PUT" });
}

/** spotify_queue — add one track to the queue. */
export async function queueTrack(env: Env, uri: string): Promise<string> {
	const u = uri?.trim();
	if (!u?.startsWith("spotify:track:")) {
		throw new Error("spotify_queue takes a track uri (spotify:track:…). Search first if you need one.");
	}
	await spotifyFetch(env, `me/player/queue?uri=${encodeURIComponent(u)}`, { method: "POST" });
	return `Queued ${u}.`;
}
