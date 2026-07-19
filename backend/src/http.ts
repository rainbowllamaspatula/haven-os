/**
 * Vale OS — one fetch discipline for every upstream call.
 *
 * Before this, only mcp.ts set a timeout; a hung Gmail/Notion/Spotify/Anthropic
 * socket could hang the whole reply, and a 429 was an unhandled failure. This
 * wraps `fetch` with:
 *   - a per-service timeout via AbortSignal.timeout (a slow upstream fails plainly
 *     instead of hanging — the abort surfaces as a throw the caller already nets),
 *   - a single bounded retry on 429 honouring Retry-After, for idempotent verbs
 *     only (a POST is never blind-retried — it might double-send).
 *
 * Deliberately NOT a client: no auth, no JSON, no caching. Callers keep their own
 * headers and error contracts; this only governs *how long* and *what on 429*.
 */

// Per-service timeout. Anthropic answers the whole tool loop, so it gets room;
// everything else should feel snappy or fail. Unlisted services take the default.
const TIMEOUTS: Record<string, number> = {
	anthropic: 60_000,
	gmail: 15_000,
	google: 15_000,
	notion: 15_000,
	spotify: 15_000,
	ha: 15_000,
	openmeteo: 15_000,
	openrouter: 15_000,
	embed: 15_000,
	// v3 renders a whole tagged performance per call — slow is fine, voice
	// notes aren't latency-bound. (Its POST never blind-retries on 429.)
	elevenlabs: 60_000,
	// A generation takes 25–35s of provider-side work before the response
	// lands; the same label covers the result-URL download. Runs in
	// ctx.waitUntil, so nobody's reply is waiting on it.
	getimg: 120_000,
};
const DEFAULT_TIMEOUT_MS = 15_000;

// A Retry-After longer than this isn't worth holding a request open for — return
// the 429 and let the caller's error path handle it.
const MAX_RETRY_WAIT_MS = 10_000;

export type FetchOptions = {
	/** Explicit timeout; overrides the per-service default. */
	timeoutMs?: number;
	/** Picks the timeout default and labels the call. */
	service?: string;
	/** Force (or forbid) the 429 retry regardless of method. Default: idempotent verbs only. */
	retryOn429?: boolean;
};

/** True for verbs safe to replay after a 429 (the request was rejected, not run). */
export function isIdempotent(method: string): boolean {
	const m = method.toUpperCase();
	return m === "GET" || m === "HEAD" || m === "PUT" || m === "DELETE";
}

export async function fetchWithTimeout(
	url: string,
	init: RequestInit = {},
	opts: FetchOptions = {},
): Promise<Response> {
	const timeoutMs =
		opts.timeoutMs ?? (opts.service ? (TIMEOUTS[opts.service] ?? DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS);
	const allowRetry = opts.retryOn429 ?? isIdempotent(init.method ?? "GET");

	const once = () => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

	let res = await once();
	if (res.status === 429 && allowRetry) {
		const header = Number(res.headers.get("Retry-After"));
		const waitMs = Number.isFinite(header) && header > 0 ? header * 1000 : 1_000;
		if (waitMs <= MAX_RETRY_WAIT_MS) {
			await new Promise((r) => setTimeout(r, waitMs));
			res = await once();
		}
	}
	return res;
}
