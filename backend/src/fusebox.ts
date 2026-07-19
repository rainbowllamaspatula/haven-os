/**
 * The Fuse Box — the side gate (Phase 1 of the admin panel).
 *
 * Same key as the house, separate lock: entering the Fuse Box re-asks for
 * VALE_PASSWORD and hands back its own 15-minute token, so a live 30-day
 * session on an unattended device doesn't leave the house's wiring exposed.
 * Per the v0.3 brief: reuse the Wave 2 gate's *pattern* — an HMAC token
 * under SESSION_SECRET, constant-time compares — without touching auth.ts.
 *
 * Domain separation, deliberate: the house session signs `<expiry>`; this
 * token signs `fusebox.<expiry>`. Same secret, disjoint message spaces — a
 * captured 15-minute Fuse Box token can never be replayed as a 30-day house
 * session, and a house token opens no fuses. Tested in both directions.
 *
 * The cookie is Path-scoped to /api/fusebox so it rides only on panel
 * routes. The TTL is hard — no sliding renewal; after 15 minutes the panel
 * re-prompts. The lock is server-side: every /api/fusebox/* route except
 * login and status 401s without a valid token, whatever the client renders.
 * (The desktop-only viewport gate is ergonomics; THIS is the security.)
 */

const COOKIE_NAME = "vale_fusebox";
const DOMAIN = "fusebox";
export const FUSEBOX_TTL_MS = 15 * 60 * 1000;

const encoder = new TextEncoder();

// Length-checked, constant-time compare — same shape as auth.ts, kept local
// so the sacred file stays untouched.
function timingSafeEqual(a: string, b: string): boolean {
	const ab = encoder.encode(a);
	const bb = encoder.encode(b);
	if (ab.length !== bb.length) return false;
	let diff = 0;
	for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
	return diff === 0;
}

// HMAC-SHA256 of a message under a key, hex-encoded.
async function hmac(message: string, key: string): Promise<string> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		encoder.encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
	return [...new Uint8Array(sig)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** Mint a fresh 15-minute Fuse Box token, domain-separated from the house session. */
export async function mintFuseboxToken(secret: string): Promise<string> {
	const expiry = String(Date.now() + FUSEBOX_TTL_MS);
	return `${expiry}.${await hmac(`${DOMAIN}.${expiry}`, secret)}`;
}

function readCookie(request: Request, name: string): string | null {
	const header = request.headers.get("Cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === name) return decodeURIComponent(v.join("="));
	}
	return null;
}

/**
 * Inspect the request's Fuse Box cookie. `unlocked` gates the panel routes;
 * `remainingMs` feeds the client's re-lock countdown (0 when locked).
 */
export async function fuseboxStatus(
	request: Request,
	secret: string,
): Promise<{ unlocked: boolean; remainingMs: number }> {
	const locked = { unlocked: false, remainingMs: 0 };
	const token = readCookie(request, COOKIE_NAME);
	if (!token) return locked;
	const dot = token.indexOf(".");
	if (dot === -1) return locked;
	const expiryStr = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	const expiry = Number(expiryStr);
	if (!Number.isFinite(expiry) || expiry < Date.now()) return locked;
	if (!timingSafeEqual(sig, await hmac(`${DOMAIN}.${expiryStr}`, secret))) return locked;
	return { unlocked: true, remainingMs: expiry - Date.now() };
}

/**
 * The Set-Cookie header for a fresh Fuse Box unlock. Path-scoped so the
 * token only ever travels to /api/fusebox/* — the rest of the app never
 * sees it.
 */
export async function fuseboxCookie(secret: string): Promise<string> {
	const token = await mintFuseboxToken(secret);
	return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/api/fusebox; Max-Age=${FUSEBOX_TTL_MS / 1000}`;
}
