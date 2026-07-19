import { describe, it, expect } from "vitest";
import { mintFuseboxToken, fuseboxStatus, fuseboxCookie, FUSEBOX_TTL_MS } from "../src/fusebox";
import { mintToken, sessionStatus } from "../src/auth";

// A test-only secret, same discipline as auth.spec.ts: signing is
// parameterised, so tests inject their own key and never touch a real one.
const SECRET = "test-only-session-secret-not-real";
const FUSEBOX_COOKIE = "vale_fusebox";
const SESSION_COOKIE = "vale_session";

function requestWithCookie(name: string, token: string): Request {
	return new Request("https://vale.test/api/fusebox/status", {
		headers: { Cookie: `${name}=${encodeURIComponent(token)}` },
	});
}

// Independently reproduce the wire format `<expiry>.<hmac("fusebox."+expiry)>`
// so tests can mint expired tokens without a clock shim. Self-checked against
// the real mintFuseboxToken below.
async function signFuseboxExpiry(expiryMs: number, secret: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const expiryStr = String(expiryMs);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`fusebox.${expiryStr}`));
	const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${expiryStr}.${hex}`;
}

describe("fusebox token wire format", () => {
	it("the test signer reproduces mintFuseboxToken's signature exactly", async () => {
		const real = await mintFuseboxToken(SECRET);
		const expiryStr = real.slice(0, real.indexOf("."));
		const reproduced = await signFuseboxExpiry(Number(expiryStr), SECRET);
		expect(reproduced).toBe(real);
	});
});

describe("fuseboxStatus - round trip", () => {
	it("accepts a freshly minted token, with the TTL as remaining time", async () => {
		const token = await mintFuseboxToken(SECRET);
		const status = await fuseboxStatus(requestWithCookie(FUSEBOX_COOKIE, token), SECRET);
		expect(status.unlocked).toBe(true);
		expect(status.remainingMs).toBeGreaterThan(0);
		expect(status.remainingMs).toBeLessThanOrEqual(FUSEBOX_TTL_MS);
	});

	it("locks a request with no cookie", async () => {
		const status = await fuseboxStatus(new Request("https://vale.test/api/fusebox/status"), SECRET);
		expect(status).toEqual({ unlocked: false, remainingMs: 0 });
	});
});

describe("fuseboxStatus - tamper rejection", () => {
	it("rejects a token whose signature has been altered", async () => {
		const token = await mintFuseboxToken(SECRET);
		const last = token.slice(-1);
		const tampered = token.slice(0, -1) + (last === "a" ? "b" : "a");
		expect(tampered).not.toBe(token);
		const status = await fuseboxStatus(requestWithCookie(FUSEBOX_COOKIE, tampered), SECRET);
		expect(status.unlocked).toBe(false);
	});

	it("rejects a malformed token with no separator", async () => {
		const status = await fuseboxStatus(requestWithCookie(FUSEBOX_COOKIE, "garbage-no-dot"), SECRET);
		expect(status.unlocked).toBe(false);
	});

	it("rejects a validly-shaped token signed with a different secret", async () => {
		const token = await mintFuseboxToken("some-other-secret");
		const status = await fuseboxStatus(requestWithCookie(FUSEBOX_COOKIE, token), SECRET);
		expect(status.unlocked).toBe(false);
	});
});

describe("fuseboxStatus - expiry rejection", () => {
	it("rejects a correctly-signed but expired token", async () => {
		const expired = await signFuseboxExpiry(Date.now() - 60_000, SECRET);
		const status = await fuseboxStatus(requestWithCookie(FUSEBOX_COOKIE, expired), SECRET);
		expect(status).toEqual({ unlocked: false, remainingMs: 0 });
	});
});

describe("domain separation - the load-bearing property", () => {
	// Both tokens are `<expiry>.<hmac>` under the SAME secret. The only thing
	// keeping a 15-minute panel token from doubling as a 30-day house session
	// (and vice versa) is the `fusebox.` domain prefix inside the signature.
	// If someone ever "simplifies" that away, these two tests are the alarm.
	it("a house session token opens no fuses", async () => {
		const houseToken = await mintToken(SECRET);
		const status = await fuseboxStatus(requestWithCookie(FUSEBOX_COOKIE, houseToken), SECRET);
		expect(status.unlocked).toBe(false);
	});

	it("a fusebox token is not a valid house session", async () => {
		const fuseboxToken = await mintFuseboxToken(SECRET);
		const req = new Request("https://vale.test/api/history", {
			headers: { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(fuseboxToken)}` },
		});
		const status = await sessionStatus(req, SECRET);
		expect(status.valid).toBe(false);
	});
});

describe("fuseboxCookie", () => {
	it("is Path-scoped to /api/fusebox with the 15-minute Max-Age", async () => {
		const cookie = await fuseboxCookie(SECRET);
		expect(cookie).toContain("vale_fusebox=");
		expect(cookie).toContain("Path=/api/fusebox");
		expect(cookie).toContain(`Max-Age=${FUSEBOX_TTL_MS / 1000}`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
	});

	it("round-trips through fuseboxStatus", async () => {
		const cookie = await fuseboxCookie(SECRET);
		const token = decodeURIComponent(cookie.split(";")[0].split("=").slice(1).join("="));
		const status = await fuseboxStatus(requestWithCookie(FUSEBOX_COOKIE, token), SECRET);
		expect(status.unlocked).toBe(true);
	});
});
