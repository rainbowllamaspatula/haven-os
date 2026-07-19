/**
 * Vale OS — the front door.
 *
 * A single shared password (the VALE_PASSWORD secret) unlocks the whole app.
 * On success the Worker hands back a signed, HttpOnly session cookie so Elle
 * isn't retyping the password on every request; the cookie is a short token,
 * `<expiry>.<hmac(expiry, key=SESSION_SECRET)>`, that the Worker can re-verify
 * without storing any session state.
 *
 * Sessions are HMAC'd with a dedicated SESSION_SECRET, NOT the password.
 * Trade-off, decided (Wave 2): changing the password no longer invalidates live
 * sessions — rotating SESSION_SECRET does. Signing with the password had turned
 * every captured cookie into an offline oracle for cracking it; a distinct
 * secret closes that. Rotate SESSION_SECRET to force a global re-login.
 *
 * Sliding renewal: a token past its halfway mark (15 of 30 days) is re-minted on
 * use and the fresh cookie rides back on the response, so an always-open device
 * never hits the silent day-30 logout. See sessionStatus + the gate in index.ts.
 *
 * Enforced in production only — the local sandbox stays open (see index.ts).
 * Because the gate lives in the Worker, it covers every hostname the Worker
 * answers on at once: the custom domain and the workers.dev URL alike.
 */

const COOKIE_NAME = "vale_session";
const SESSION_DAYS = 30;
// Past this much of the window elapsed, a valid token is re-minted on use.
const RENEW_AFTER_MS = (SESSION_DAYS / 2) * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

// Length-checked, constant-time compare, so a wrong password can't be teased
// out one character at a time by measuring how long the comparison took.
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

// Mint a fresh session token, signed with SESSION_SECRET as the key.
export async function mintToken(secret: string): Promise<string> {
	const expiry = String(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
	return `${expiry}.${await hmac(expiry, secret)}`;
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
 * Inspect the request's session cookie. `valid` gates access; `renew` is true
 * when a still-valid token is past its halfway mark, signalling the gate to
 * re-mint and attach a fresh cookie so an always-open device never silently
 * logs out at day 30.
 */
export async function sessionStatus(
	request: Request,
	secret: string,
): Promise<{ valid: boolean; renew: boolean }> {
	const token = readCookie(request, COOKIE_NAME);
	if (!token) return { valid: false, renew: false };
	const dot = token.indexOf(".");
	if (dot === -1) return { valid: false, renew: false };
	const expiryStr = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	const expiry = Number(expiryStr);
	if (!Number.isFinite(expiry) || expiry < Date.now()) return { valid: false, renew: false };
	if (!timingSafeEqual(sig, await hmac(expiryStr, secret))) return { valid: false, renew: false };
	return { valid: true, renew: expiry - Date.now() < RENEW_AFTER_MS };
}

/** Constant-time password check, for the /api/login handler. */
export function passwordMatches(input: unknown, expected: string): boolean {
	return typeof input === "string" && timingSafeEqual(input, expected);
}

/** The Set-Cookie header value for a fresh 30-day session, signed with the secret. */
export async function sessionCookie(secret: string): Promise<string> {
	const token = await mintToken(secret);
	const maxAge = SESSION_DAYS * 24 * 60 * 60;
	return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

/**
 * The login page. Self-contained — inline CSS and JS, no external assets — so an
 * unauthenticated visitor never pulls a single byte of the real app. On a
 * correct password it reloads, and the reloaded request carries the new cookie.
 */
export function loginPage(): Response {
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Vale OS</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0f1417; color: #e8eef0;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .card {
    width: min(92vw, 360px); padding: 2.5rem 2rem; text-align: center;
    background: #161d21; border: 1px solid #243036; border-radius: 16px;
  }
  h1 { margin: 0 0 .35rem; font-size: 1.5rem; letter-spacing: .02em; color: #1B7B7E; }
  p { margin: 0 0 1.5rem; font-size: .9rem; color: #8aa0a6; }
  input {
    width: 100%; padding: .8rem 1rem; font-size: 1rem;
    background: #0f1417; color: #e8eef0;
    border: 1px solid #2c3a40; border-radius: 10px; outline: none;
  }
  input:focus { border-color: #1B7B7E; }
  button {
    width: 100%; margin-top: .9rem; padding: .8rem 1rem; font-size: 1rem; font-weight: 600;
    color: #07100f; background: #1B7B7E; border: 0; border-radius: 10px; cursor: pointer;
  }
  button:hover { background: #239093; }
  .err { margin-top: .9rem; min-height: 1.1em; font-size: .85rem; color: #d98a8a; }
</style>
</head>
<body>
  <div class="card">
    <h1>Vale OS</h1>
    <p>This is ours. Let yourself in.</p>
    <input id="pw" type="password" placeholder="Password" autocomplete="current-password" autofocus />
    <button id="go">Enter</button>
    <div class="err" id="err"></div>
  </div>
<script>
  const pw = document.getElementById('pw');
  const err = document.getElementById('err');
  async function submit() {
    err.textContent = '';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw.value }),
      });
      if (res.ok) { location.reload(); return; }
    } catch (e) { /* fall through to the error message */ }
    err.textContent = 'Wrong password.';
    pw.value = '';
    pw.focus();
  }
  document.getElementById('go').addEventListener('click', submit);
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
</script>
</body>
</html>`;
	return new Response(html, {
		status: 200,
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}
