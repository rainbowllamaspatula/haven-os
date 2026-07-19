/**
 * Gmail low-level client — OAuth + REST, shared by every Gmail surface.
 *
 * Born out of the Workshop Mail tile's mail.ts: the token exchange, the cached
 * access token, and the GET helper were read-only there. The Post Box widened the
 * OAuth scope to gmail.modify (a re-consent, not a rebuild — same client), so this
 * now also POSTs: label edits, sends, drafts. Everything message-shaped lives in
 * postbox.ts; this file is just auth + transport.
 *
 * The scope is gmail.modify — a superset of the old gmail.readonly — so reading
 * still works exactly as before, and writing (labels / send / drafts) is now
 * possible too. Permanent delete is still out of reach (that needs mail.google.com);
 * the read view's "Delete" is a trash move, which modify covers.
 */

import { fetchWithTimeout } from "./http";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

// --- OAuth: refresh token → access token, cached until ~expiry ---
// Module-level (per-isolate) so we don't mint a fresh access token every
// request — the refresh-token grant is the expensive, rate-limited call.
let accessToken: { token: string; expiresAt: number } | null = null;
// Single-flight: concurrent cold calls share one in-flight refresh rather than
// each firing its own grant.
let refreshInFlight: Promise<string> | null = null;

export async function getAccessToken(env: Env): Promise<string> {
	// Refresh a minute early so a token can't expire mid-flight.
	if (accessToken && Date.now() < accessToken.expiresAt - 60_000) return accessToken.token;
	if (refreshInFlight) return refreshInFlight;

	refreshInFlight = (async () => {
		try {
			const body = new URLSearchParams({
				client_id: env.GMAIL_CLIENT_ID,
				client_secret: env.GMAIL_CLIENT_SECRET,
				refresh_token: env.GMAIL_REFRESH_TOKEN,
				grant_type: "refresh_token",
			});
			const res = await fetchWithTimeout(
				GOOGLE_TOKEN_URL,
				{
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body,
				},
				{ service: "google" },
			);
			if (!res.ok) throw new Error(`Google token ${res.status}: ${await res.text()}`);
			// expires_in can be absent; default an hour, as spotify.ts already does.
			const data = (await res.json()) as { access_token: string; expires_in?: number };
			accessToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
			return data.access_token;
		} finally {
			refreshInFlight = null;
		}
	})();
	return refreshInFlight;
}

// --- Gmail REST ---
export type GmailHeader = { name: string; value: string };
export type GmailPart = {
	mimeType?: string;
	filename?: string;
	headers?: GmailHeader[];
	body?: { data?: string; size?: number; attachmentId?: string };
	parts?: GmailPart[];
};
export type GmailMessage = {
	id: string;
	threadId: string;
	snippet?: string;
	labelIds?: string[];
	internalDate?: string;
	payload?: GmailPart;
};

/** Authenticated GET against the Gmail REST API. Throws on a non-OK response. */
export async function gmailGet(env: Env, path: string): Promise<unknown> {
	const token = await getAccessToken(env);
	const res = await fetchWithTimeout(
		`${GMAIL_API}${path}`,
		{ headers: { Authorization: `Bearer ${token}` } },
		{ service: "gmail" },
	);
	if (!res.ok) throw new Error(`Gmail GET ${path} ${res.status}: ${await res.text()}`);
	return res.json();
}

/** Authenticated JSON POST against the Gmail REST API. Throws on a non-OK response. */
export async function gmailPost(env: Env, path: string, body: unknown): Promise<unknown> {
	const token = await getAccessToken(env);
	const res = await fetchWithTimeout(
		`${GMAIL_API}${path}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		},
		{ service: "gmail" },
	);
	if (!res.ok) throw new Error(`Gmail POST ${path} ${res.status}: ${await res.text()}`);
	return res.json();
}

/** Authenticated JSON PUT (drafts.update). Throws on a non-OK response. */
export async function gmailPut(env: Env, path: string, body: unknown): Promise<unknown> {
	const token = await getAccessToken(env);
	const res = await fetchWithTimeout(
		`${GMAIL_API}${path}`,
		{
			method: "PUT",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		},
		{ service: "gmail" },
	);
	if (!res.ok) throw new Error(`Gmail PUT ${path} ${res.status}: ${await res.text()}`);
	return res.json();
}

/** Authenticated DELETE. Tolerates 404 (already gone). No body to parse. */
export async function gmailDelete(env: Env, path: string): Promise<void> {
	const token = await getAccessToken(env);
	const res = await fetchWithTimeout(
		`${GMAIL_API}${path}`,
		{
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		},
		{ service: "gmail" },
	);
	if (!res.ok && res.status !== 404) {
		throw new Error(`Gmail DELETE ${path} ${res.status}: ${await res.text()}`);
	}
}

/** First header matching `name` (case-insensitive), or "". */
export function header(headers: GmailHeader[], name: string): string {
	return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

// "Some One <someone@x.com>" -> "Some One"; a bare address → the address. Strips
// the surrounding quotes Gmail sometimes wraps a display name in.
export function parseFrom(value: string): string {
	const m = /^(.*?)\s*<(.+?)>\s*$/.exec(value);
	if (m) return m[1].replace(/^"|"$/g, "").trim() || m[2];
	return value.trim();
}

// "Some One <someone@x.com>" -> "someone@x.com"; a bare address → itself.
export function parseAddress(value: string): string {
	const m = /<(.+?)>/.exec(value);
	return (m ? m[1] : value).trim();
}

// --- base64url (Gmail's raw-message + body-part encoding) ---
export function b64urlEncode(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_");
}

export function b64urlDecode(data: string): Uint8Array {
	const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
