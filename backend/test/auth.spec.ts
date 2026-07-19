import { describe, it, expect } from "vitest";
import { mintToken, sessionStatus } from "../src/auth";

// A test-only secret. Never a real value, never read from env — the whole point of
// Wave 2's SESSION_SECRET is that signing is parameterised, so tests inject their
// own key. Rotating the real secret must never be needed to run these.
const SECRET = "test-only-session-secret-not-real";
const COOKIE_NAME = "vale_session";
const DAY_MS = 24 * 60 * 60 * 1000;

// Wrap a raw token in the request the Worker actually inspects.
function requestWithToken(token: string): Request {
	return new Request("https://vale.test/api/history", {
		headers: { Cookie: `${COOKIE_NAME}=${encodeURIComponent(token)}` },
	});
}

// Independently reproduce the token wire format `<expiry>.<hmac(expiry, secret)>`,
// so tests can mint tokens with an arbitrary expiry (past / near / far) without a
// clock shim. Self-checked against the real mintToken below.
async function signExpiry(expiryMs: number, secret: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const expiryStr = String(expiryMs);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(expiryStr));
	const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${expiryStr}.${hex}`;
}

describe("auth token wire format", () => {
	it("the test signer reproduces mintToken's signature exactly", async () => {
		// Guards the rest of the file: if this drifts from production, the crafted
		// tokens below would fail for the wrong reason.
		const real = await mintToken(SECRET);
		const expiryStr = real.slice(0, real.indexOf("."));
		const reproduced = await signExpiry(Number(expiryStr), SECRET);
		expect(reproduced).toBe(real);
	});
});

describe("sessionStatus - round trip", () => {
	it("accepts a freshly minted token", async () => {
		const token = await mintToken(SECRET);
		const status = await sessionStatus(requestWithToken(token), SECRET);
		expect(status.valid).toBe(true);
	});

	it("a fresh 30-day token is not yet up for renewal", async () => {
		const token = await mintToken(SECRET);
		const status = await sessionStatus(requestWithToken(token), SECRET);
		expect(status).toEqual({ valid: true, renew: false });
	});

	it("rejects a request with no cookie", async () => {
		const status = await sessionStatus(new Request("https://vale.test/api/history"), SECRET);
		expect(status).toEqual({ valid: false, renew: false });
	});
});

describe("sessionStatus - tamper rejection", () => {
	it("rejects a token whose signature has been altered", async () => {
		const token = await mintToken(SECRET);
		const last = token.slice(-1);
		const tampered = token.slice(0, -1) + (last === "a" ? "b" : "a");
		expect(tampered).not.toBe(token);
		const status = await sessionStatus(requestWithToken(tampered), SECRET);
		expect(status.valid).toBe(false);
	});

	it("rejects a malformed token with no separator", async () => {
		const status = await sessionStatus(requestWithToken("garbage-no-dot"), SECRET);
		expect(status.valid).toBe(false);
	});

	it("rejects a validly-shaped token signed with a different secret", async () => {
		const token = await mintToken("some-other-secret");
		const status = await sessionStatus(requestWithToken(token), SECRET);
		expect(status.valid).toBe(false);
	});
});

describe("sessionStatus - expiry rejection", () => {
	it("rejects a correctly-signed but expired token", async () => {
		const expired = await signExpiry(Date.now() - 60_000, SECRET);
		const status = await sessionStatus(requestWithToken(expired), SECRET);
		expect(status).toEqual({ valid: false, renew: false });
	});
});

describe("sessionStatus - sliding renewal boundary", () => {
	// RENEW_AFTER_MS is half the 30-day window: a valid token with < 15 days left
	// is flagged for re-mint; one with more is not.
	it("does not renew a token still more than halfway from expiry", async () => {
		const token = await signExpiry(Date.now() + 16 * DAY_MS, SECRET);
		const status = await sessionStatus(requestWithToken(token), SECRET);
		expect(status).toEqual({ valid: true, renew: false });
	});

	it("renews a valid token past its halfway mark", async () => {
		const token = await signExpiry(Date.now() + 14 * DAY_MS, SECRET);
		const status = await sessionStatus(requestWithToken(token), SECRET);
		expect(status).toEqual({ valid: true, renew: true });
	});
});
