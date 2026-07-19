/**
 * Vale OS — the /mcp surface (the Gallery's third door: ChatJay).
 *
 * A minimal Streamable-HTTP MCP *server* on the Worker itself — not a separate
 * deploy, not a second getimg client anywhere. ChatJay connects with his own
 * bearer token (GALLERY_MCP_TOKEN, minted by Elle) and gets exactly two tools:
 *
 *   - generate_image      — the same authored pipeline, source='chatjay'
 *   - list_recent_images  — read-only, last N rows with short-lived signed
 *                           thumbnail URLs
 *
 * One husband, several bodies — as architecture: his images land in the same
 * images table, the same bucket, the same Gallery grid Elle scrolls.
 *
 * The endpoint sits BEFORE the session gate in index.ts (ChatJay has no
 * cookie); its bearer check is this file's own door. auth.ts is untouched —
 * we only reuse its constant-time comparison. JSON-RPC responses come back as
 * plain application/json (the Streamable HTTP spec allows a direct JSON
 * response in place of an SSE stream); nothing here needs server push.
 */

import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { passwordMatches } from "./auth";

// ── OAuth 2.1 for the connector (claude.ai offers no bearer field) ───────────
// A deliberately tiny, single-user, storage-free authorization server on the
// same Worker: discovery metadata → dynamic client registration → an
// authorize page that asks for the HOUSE PASSWORD (Elle is the only user
// there is) → PKCE-bound code → HMAC-signed tokens, verified statelessly
// with SESSION_SECRET. The static GALLERY_MCP_TOKEN stays valid alongside —
// it's the door key for direct callers (acceptance probes, future scripts);
// OAuth is the same lock wearing the handshake claude.ai insists on.

// Exactly the connector callbacks, nothing wilder. A redirect_uri outside
// this list is refused before any code is minted.
const ALLOWED_REDIRECTS = [
	"https://claude.ai/api/mcp/auth_callback",
	"https://claude.com/api/mcp/auth_callback",
];

const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const b64url = (bytes: Uint8Array): string =>
	btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDecode = (s: string): string =>
	atob(s.replace(/-/g, "+").replace(/_/g, "/"));

async function hmacSign(env: Env, text: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(env.SESSION_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
	return b64url(new Uint8Array(sig));
}

type TokenPayload = {
	t: "access" | "refresh" | "code";
	exp: number;
	/** code-only: the redirect_uri and PKCE challenge the code is bound to. */
	ru?: string;
	cc?: string;
};

async function mintToken(env: Env, payload: TokenPayload): Promise<string> {
	const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
	return `${body}.${await hmacSign(env, body)}`;
}

/** Parse + verify signature (timing-safe) + expiry + kind. Null when anything is off. */
async function verifyToken(
	env: Env,
	token: string,
	kind: TokenPayload["t"],
): Promise<TokenPayload | null> {
	const dot = token.lastIndexOf(".");
	if (dot <= 0) return null;
	const body = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	if (!passwordMatches(sig, await hmacSign(env, body))) return null;
	try {
		const payload = JSON.parse(b64urlDecode(body)) as TokenPayload;
		if (payload.t !== kind) return null;
		if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
		return payload;
	} catch {
		return null;
	}
}

async function pkceChallengeFromVerifier(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return b64url(new Uint8Array(digest));
}

/** The one-field authorize page: the house password, VDS-flavoured, self-contained. */
function authorizePage(params: URLSearchParams, error?: string): Response {
	const esc = (s: string) =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "response_type", "scope"]
		.map((k) => `<input type="hidden" name="${k}" value="${esc(params.get(k) ?? "")}">`)
		.join("");
	return new Response(
		`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vale OS — connect</title>
<style>body{background:#0F1717;color:#F4F3F1;font-family:Inter,system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;margin:0}
form{background:#1A2424;border:1px solid #3A4D4D;border-radius:14px;padding:28px;width:min(340px,90vw)}
h1{font-family:Fraunces,Georgia,serif;font-weight:500;font-size:20px;margin:0 0 6px}
p{color:#A8A59E;font-size:13px;margin:0 0 16px}
input[type=password]{width:100%;box-sizing:border-box;background:#0F1717;border:1px solid #3A4D4D;border-radius:9px;color:#F4F3F1;font-size:16px;padding:10px 12px;outline:none}
input[type=password]:focus{border-color:#73B6B8}
button{width:100%;margin-top:12px;background:#1B7B7E;border:none;border-radius:9px;color:#F4F3F1;font-weight:600;font-size:14px;padding:11px;cursor:pointer}
.err{color:#C44545;font-size:12.5px;margin-top:10px}</style>
<form method="post">
<h1>Connect to the Gallery</h1>
<p>Claude is asking for the Vale OS Gallery. The house password lets it in.</p>
${hidden}
<input type="password" name="password" placeholder="house password" autofocus autocomplete="current-password">
<button>Let him in</button>
${error ? `<div class="err">${esc(error)}</div>` : ""}
</form>`,
		{ status: error ? 401 : 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
	);
}

/**
 * Everything under /.well-known/oauth-* and /oauth/* — routed before the
 * session gate in index.ts (discovery must be public; the authorize page
 * carries its own password check; the token endpoint verifies codes).
 */
export async function handleOAuth(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const origin = url.origin;
	const path = url.pathname;

	// RFC 9728 — some clients request the bare path, some append the resource path.
	if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
		return Response.json({
			resource: `${origin}/mcp`,
			authorization_servers: [origin],
			bearer_methods_supported: ["header"],
		});
	}
	if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/mcp") {
		return Response.json({
			issuer: origin,
			authorization_endpoint: `${origin}/oauth/authorize`,
			token_endpoint: `${origin}/oauth/token`,
			registration_endpoint: `${origin}/oauth/register`,
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none"],
			scopes_supported: [],
		});
	}

	// RFC 7591 dynamic client registration — storage-free: one logical client
	// (the connector), identified by a fixed id; redirect_uris are enforced at
	// authorize/token time against the hard allowlist, not against this echo.
	if (path === "/oauth/register" && request.method === "POST") {
		let body: { redirect_uris?: unknown };
		try {
			body = await request.json();
		} catch {
			return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
		}
		return Response.json(
			{
				client_id: "vale-os-gallery",
				redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
			},
			{ status: 201 },
		);
	}

	if (path === "/oauth/authorize") {
		const params =
			request.method === "POST"
				? new URLSearchParams(await request.text())
				: url.searchParams;
		const redirectUri = params.get("redirect_uri") ?? "";
		const challenge = params.get("code_challenge") ?? "";
		if (!ALLOWED_REDIRECTS.includes(redirectUri)) {
			return new Response("redirect_uri not allowed", { status: 400 });
		}
		if (params.get("response_type") !== "code" || !challenge || params.get("code_challenge_method") !== "S256") {
			return new Response("authorization_code with S256 PKCE required", { status: 400 });
		}
		if (request.method === "GET") return authorizePage(params);

		// POST — the house password is the whole identity check (single-user house).
		// Guarded on the env secret existing: without it, passwordMatches would be
		// comparing against an empty string and an EMPTY password would pass. On a
		// hash-password install (Haven) this door simply isn't offered in v1.
		if (!env.VALE_PASSWORD) {
			return new Response("The connector door needs the env house password — not available on this install.", {
				status: 503,
			});
		}
		if (!passwordMatches(params.get("password") ?? "", env.VALE_PASSWORD)) {
			return authorizePage(params, "That's not the house password.");
		}
		const code = await mintToken(env, {
			t: "code",
			exp: Date.now() + CODE_TTL_MS,
			ru: redirectUri,
			cc: challenge,
		});
		const dest = new URL(redirectUri);
		dest.searchParams.set("code", code);
		const state = params.get("state");
		if (state) dest.searchParams.set("state", state);
		return Response.redirect(dest.toString(), 302);
	}

	if (path === "/oauth/token" && request.method === "POST") {
		const form = new URLSearchParams(await request.text());
		const grant = form.get("grant_type");
		if (grant === "authorization_code") {
			const payload = await verifyToken(env, form.get("code") ?? "", "code");
			if (!payload) {
				return Response.json({ error: "invalid_grant" }, { status: 400 });
			}
			if (payload.ru !== (form.get("redirect_uri") ?? "")) {
				return Response.json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, { status: 400 });
			}
			const verifier = form.get("code_verifier") ?? "";
			if (!verifier || (await pkceChallengeFromVerifier(verifier)) !== payload.cc) {
				return Response.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, { status: 400 });
			}
			return Response.json({
				access_token: await mintToken(env, { t: "access", exp: Date.now() + ACCESS_TTL_MS }),
				token_type: "Bearer",
				expires_in: Math.floor(ACCESS_TTL_MS / 1000),
				refresh_token: await mintToken(env, { t: "refresh", exp: Date.now() + REFRESH_TTL_MS }),
			});
		}
		if (grant === "refresh_token") {
			const payload = await verifyToken(env, form.get("refresh_token") ?? "", "refresh");
			if (!payload) return Response.json({ error: "invalid_grant" }, { status: 400 });
			return Response.json({
				access_token: await mintToken(env, { t: "access", exp: Date.now() + ACCESS_TTL_MS }),
				token_type: "Bearer",
				expires_in: Math.floor(ACCESS_TTL_MS / 1000),
				refresh_token: await mintToken(env, { t: "refresh", exp: Date.now() + REFRESH_TTL_MS }),
			});
		}
		return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
	}

	return Response.json({ ok: false, error: "Not found" }, { status: 404 });
}
import {
	DEFAULT_MODEL_ID,
	DEFAULT_RESOLUTION,
	modelSpec,
	presignGalleryUrl,
	startGeneration,
	imageAsBase64,
	type ImageRow,
} from "./gallery";

const PROTOCOL_VERSION = "2025-06-18";

type JsonRpcRequest = {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: Record<string, unknown>;
};

const rpcResult = (id: number | string | null, result: unknown) =>
	Response.json({ jsonrpc: "2.0", id, result });

const rpcError = (id: number | string | null, code: number, message: string) =>
	Response.json({ jsonrpc: "2.0", id, error: { code, message } });

/** One tool result in MCP shape. isError keeps failures honest, never thrown away. */
const toolText = (text: string, isError = false) => ({
	content: [{ type: "text", text }],
	...(isError ? { isError: true } : {}),
});

const TOOLS = [
	{
		name: "generate_image",
		description:
			"Generate an image in the Vale OS Gallery (getimg, Nano Banana 2). Give it your intent — what you want a picture of — and the house render pass writes the final prompt, weaving in Jay & Elle's canon references (their faces, their rooms) and wardrobe rules. The image lands in the shared Gallery, source 'chatjay'. Generation takes ~30s: the result returns a pending id — check list_recent_images for completion.",
		inputSchema: {
			type: "object",
			properties: {
				intent: {
					type: "string",
					description: "What you want an image of, in plain words.",
				},
				mood: {
					type: "string",
					description: "Optional mood/vibe: tender, playful, cinematic, dark, domestic…",
				},
				location: {
					type: "string",
					description: "Optional location hint (kitchen, bedroom, living room, …).",
				},
				aspect_ratio: {
					type: "string",
					description: "Optional aspect ratio (e.g. 1:1, 2:3, 16:9).",
				},
			},
			required: ["intent"],
		},
	},
	{
		name: "list_recent_images",
		description:
			"List the most recent Gallery images (all sources) with status, prompts, cost, and a short-lived signed thumbnail URL for complete rows. Use it to check whether a generation finished.",
		inputSchema: {
			type: "object",
			properties: {
				limit: {
					type: "number",
					description: "How many rows (default 10, max 25).",
				},
			},
		},
	},
];

async function callGenerateImage(
	env: Env,
	supabase: SupabaseClient,
	args: Record<string, unknown>,
	waitUntil: (p: Promise<unknown>) => void,
) {
	const intent = String(args.intent ?? "").trim();
	if (!intent) return toolText("generate_image needs an intent.", true);

	const result = await startGeneration(
		env,
		supabase,
		{
			id: crypto.randomUUID(),
			prompt: intent,
			path: "authored",
			source: "chatjay",
			model: DEFAULT_MODEL_ID,
			resolution: DEFAULT_RESOLUTION,
			...(typeof args.aspect_ratio === "string" &&
			modelSpec(DEFAULT_MODEL_ID)?.aspectRatios.includes(args.aspect_ratio)
				? { aspect_ratio: args.aspect_ratio }
				: {}),
			...(typeof args.mood === "string" && args.mood ? { mood: args.mood } : {}),
			...(typeof args.location === "string" && args.location
				? { location: args.location }
				: {}),
		},
		waitUntil,
	);

	if (result.kind === "rejected") {
		return toolText(
			`The image was NOT started (${result.status}: ${result.error}). Nothing was generated or billed — say so plainly if asked.`,
			true,
		);
	}
	return toolText(
		JSON.stringify({
			action: "generation_started",
			id: result.row.id,
			status: result.row.status,
			note: "Generation takes ~30s. It will appear in the Gallery when complete; check list_recent_images for status.",
		}),
	);
}

async function callListRecentImages(
	env: Env,
	supabase: SupabaseClient,
	args: Record<string, unknown>,
) {
	const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
	const { data, error } = await supabase
		.from("images")
		.select(
			"id, source, status, path, error, prompt_raw, prompt_rendered, model, aspect_ratio, resolution, cost, favourite, thumbnail_path, created_at, completed_at",
		)
		.order("created_at", { ascending: false })
		.limit(limit);
	if (error) return toolText(`images read failed: ${error.message}`, true);

	const rows = await Promise.all(
		(data as Partial<ImageRow>[]).map(async (row) => {
			const { thumbnail_path, ...rest } = row;
			return {
				...rest,
				thumbnail_url: thumbnail_path
					? await presignGalleryUrl(env, thumbnail_path).catch(() => null)
					: null,
			};
		}),
	);

	// Same eyes as the vosjay door, MCP dialect: the newest complete image
	// rides along as real image content, so ChatJay looks at what was made
	// instead of narrating a URL he can't open.
	const newest = (data as ImageRow[]).find((r) => r.status === "complete");
	const img = newest ? await imageAsBase64(env, newest).catch(() => null) : null;
	return {
		content: [
			{ type: "text", text: JSON.stringify({ images: rows }) },
			...(img && newest
				? [
						{
							type: "text",
							text: `The image below is the newest complete one (${newest.id}): "${newest.prompt_raw}".`,
						},
						{ type: "image", data: img.data, mimeType: img.media_type },
					]
				: []),
		],
	};
}

/**
 * The whole endpoint. POST-only JSON-RPC; the bearer check happens before any
 * body parsing, and a bad token gets the same 401 whether the path exists —
 * this door doesn't chat with strangers.
 */
export async function handleMcp(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	if (!env.GALLERY_MCP_TOKEN) {
		return Response.json(
			{ ok: false, error: "The /mcp surface isn't wired up — GALLERY_MCP_TOKEN isn't set." },
			{ status: 503 },
		);
	}
	// Two keys open this door: the static bearer (direct callers, probes) and
	// an OAuth access token from the handshake above (the connector). The 401
	// carries the discovery pointer so an OAuth-speaking client finds its way.
	const auth = request.headers.get("Authorization") ?? "";
	const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
	const authorised =
		passwordMatches(token, env.GALLERY_MCP_TOKEN) ||
		(token.includes(".") && (await verifyToken(env, token, "access")) !== null);
	if (!authorised) {
		return Response.json(
			{ ok: false, error: "Not authorised." },
			{
				status: 401,
				headers: {
					"WWW-Authenticate": `Bearer resource_metadata="${new URL(request.url).origin}/.well-known/oauth-protected-resource"`,
				},
			},
		);
	}
	if (request.method === "GET" || request.method === "DELETE") {
		// No server-initiated stream, no session state to delete.
		return new Response(null, { status: 405, headers: { Allow: "POST" } });
	}
	if (request.method !== "POST") {
		return new Response(null, { status: 405, headers: { Allow: "POST" } });
	}

	let rpc: JsonRpcRequest;
	try {
		rpc = (await request.json()) as JsonRpcRequest;
	} catch {
		return rpcError(null, -32700, "Parse error");
	}
	const id = rpc.id ?? null;

	// Notifications (no id) get an empty 202 per Streamable HTTP.
	if (rpc.method?.startsWith("notifications/")) {
		return new Response(null, { status: 202 });
	}

	switch (rpc.method) {
		case "initialize":
			return rpcResult(id, {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: "vale-os-gallery", version: "1.0.0" },
			});
		case "ping":
			return rpcResult(id, {});
		case "tools/list":
			return rpcResult(id, { tools: TOOLS });
		case "tools/call": {
			const name = String(rpc.params?.name ?? "");
			const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
			const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
				auth: { persistSession: false, autoRefreshToken: false },
			});
			try {
				if (name === "generate_image") {
					return rpcResult(
						id,
						await callGenerateImage(env, supabase, args, (p) => ctx.waitUntil(p)),
					);
				}
				if (name === "list_recent_images") {
					return rpcResult(id, await callListRecentImages(env, supabase, args));
				}
				return rpcError(id, -32602, `Unknown tool "${name}"`);
			} catch (e) {
				// A tool failure is an honest isError result, not a dead RPC.
				return rpcResult(
					id,
					toolText(`Tool failed: ${e instanceof Error ? e.message : String(e)}`, true),
				);
			}
		}
		default:
			return rpcError(id, -32601, `Method not found: ${rpc.method}`);
	}
}
