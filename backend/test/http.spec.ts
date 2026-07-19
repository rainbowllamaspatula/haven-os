import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithTimeout, isIdempotent } from "../src/http";

describe("isIdempotent", () => {
	it("treats GET/HEAD/PUT/DELETE as replayable", () => {
		for (const m of ["GET", "HEAD", "PUT", "DELETE"]) expect(isIdempotent(m)).toBe(true);
	});

	it("treats POST/PATCH as not replayable", () => {
		for (const m of ["POST", "PATCH"]) expect(isIdempotent(m)).toBe(false);
	});

	it("is case-insensitive", () => {
		expect(isIdempotent("get")).toBe(true);
		expect(isIdempotent("post")).toBe(false);
	});
});

describe("fetchWithTimeout - bounded 429 retry", () => {
	afterEach(() => vi.unstubAllGlobals());

	// A fetch stub that hands back a scripted sequence of responses and counts calls.
	function stubFetch(responses: Response[]) {
		let i = 0;
		const spy = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);
		vi.stubGlobal("fetch", spy);
		return spy;
	}

	const r429 = (retryAfter?: string) =>
		new Response("rate limited", {
			status: 429,
			headers: retryAfter ? { "Retry-After": retryAfter } : {},
		});

	it("does not retry a POST on 429 (non-idempotent)", async () => {
		const spy = stubFetch([r429("0.01"), new Response("ok", { status: 200 })]);
		const res = await fetchWithTimeout("https://x.test", { method: "POST" }, { service: "notion" });
		expect(spy).toHaveBeenCalledTimes(1);
		expect(res.status).toBe(429);
	});

	it("does not retry when Retry-After exceeds the bound", async () => {
		// Retry-After: 20s → 20000ms > MAX_RETRY_WAIT_MS (10s): return the 429 rather
		// than hold the request open.
		const spy = stubFetch([r429("20"), new Response("ok", { status: 200 })]);
		const res = await fetchWithTimeout("https://x.test", { method: "GET" }, { service: "notion" });
		expect(spy).toHaveBeenCalledTimes(1);
		expect(res.status).toBe(429);
	});

	it("retries an idempotent GET once within the bound and returns the retry", async () => {
		const spy = stubFetch([r429("0.01"), new Response("ok", { status: 200 })]);
		const res = await fetchWithTimeout("https://x.test", { method: "GET" }, { service: "notion" });
		expect(spy).toHaveBeenCalledTimes(2);
		expect(res.status).toBe(200);
	});

	it("retries at most once even if the retry also 429s", async () => {
		const spy = stubFetch([r429("0.01"), r429("0.01"), new Response("ok", { status: 200 })]);
		const res = await fetchWithTimeout("https://x.test", { method: "GET" }, { service: "notion" });
		expect(spy).toHaveBeenCalledTimes(2);
		expect(res.status).toBe(429);
	});

	it("honours an explicit retryOn429 override on a POST", async () => {
		const spy = stubFetch([r429("0.01"), new Response("ok", { status: 200 })]);
		const res = await fetchWithTimeout(
			"https://x.test",
			{ method: "POST" },
			{ service: "notion", retryOn429: true },
		);
		expect(spy).toHaveBeenCalledTimes(2);
		expect(res.status).toBe(200);
	});
});
