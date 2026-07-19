/**
 * Vale OS — the MCP attach rail.
 *
 * The generic client that lets an external MCP server's tools ride the tool
 * registry as ordinary non-resident entries. Server-agnostic: given a server
 * config (URL + bearer token), it speaks the MCP Streamable HTTP transport —
 * plain JSON-RPC POSTs from a stateless Worker, no SSE session to hold — and
 * exposes exactly one operation: call a named tool with an args object, get a
 * flat ToolResult back.
 *
 * Home Assistant is the first (and, per Engineering Spec §4, the one
 * warranted) passenger; its curated entries live in tools.ts. Attaching
 * another server later is a new config + curated entries — never a new client.
 *
 * Error contract — this module NEVER throws (unlike spotify.ts, whose throws
 * runTool nets): transport failures, auth rejections, JSON-RPC errors and MCP
 * tool errors all fold into { content, is_error: true }, so a dead endpoint or
 * a bad token can't cost Jay a reply.
 *
 * Protocol notes (probed 4 Jul 2026 against current HA MCP Server docs):
 * - Streamable HTTP: every message is an HTTP POST; the response body is
 *   either application/json or a text/event-stream that carries the JSON-RPC
 *   response as SSE data lines. Both shapes are parsed here.
 * - The initialize/initialized handshake runs once per isolate per server and
 *   is cached. A server-issued Mcp-Session-Id is echoed on later calls (HA's
 *   stateless server doesn't issue one); a 404 against a cached session drops
 *   the cache and re-runs the handshake once, per spec.
 */

import { fetchWithTimeout } from "./http";
import { getSecret } from "./secrets";

/**
 * MCP tool results are always flat text — deliberately narrower than
 * tools.ts's ToolResult (whose content may carry image blocks since
 * view_gallery), and assignable to it wherever a registry entry returns one.
 */
export type McpToolResult = { content: string; is_error: boolean };

/** One attachable server. `label` is the human name error messages wear. */
export type McpServer = {
	label: string;
	url: string;
	token: string;
};

/**
 * The Home Assistant server config — the rail's first passenger. Kept here,
 * beside the client, so exactly one place knows how HA attaches: the brain's
 * ha_* registry entries (tools.ts) and the Hearth's /api/home routes (home.ts)
 * both build from this. Never a second config, never a second client.
 * Async since the cutover: both pieces resolve through the Secrets Store
 * per-request (secrets.ts), so a rotation is live on the very next call.
 */
export const haServer = async (env: Env): Promise<McpServer> => ({
	label: "Home Assistant",
	url: await getSecret(env, "HA_MCP_URL"),
	token: await getSecret(env, "HA_TOKEN"),
});

// The newest protocol revision the handshake offers; the server answers with
// the one it speaks and we echo that back on every later request.
const PROTOCOL_VERSION = "2025-06-18";

type Session = { sessionId: string | null; protocolVersion: string };

// Handshake cache, keyed by server URL, per isolate — same lifetime and
// pattern as spotify.ts's token cache.
const sessions = new Map<string, Session>();
// Single-flight for the handshake: concurrent cold calls share one initialize
// rather than each running its own.
const sessionPromises = new Map<string, Promise<Session>>();

let rpcId = 0;

type JsonRpcMessage = {
	jsonrpc?: string;
	id?: number | string | null;
	result?: Record<string, unknown>;
	error?: { code?: number; message?: string };
};

const ok = (content: string): McpToolResult => ({ content, is_error: false });
const err = (content: string): McpToolResult => ({ content, is_error: true });

function headers(server: McpServer, session?: Session | null): Record<string, string> {
	const h: Record<string, string> = {
		Authorization: `Bearer ${server.token}`,
		"Content-Type": "application/json",
		// The spec requires offering both — servers may 406 otherwise.
		Accept: "application/json, text/event-stream",
	};
	if (session) {
		h["MCP-Protocol-Version"] = session.protocolVersion;
		if (session.sessionId) h["Mcp-Session-Id"] = session.sessionId;
	}
	return h;
}

function post(server: McpServer, body: unknown, session?: Session | null): Promise<Response> {
	// A house-check should feel snappy or fail plainly — never hang the reply.
	return fetchWithTimeout(
		server.url,
		{
			method: "POST",
			headers: headers(server, session),
			body: JSON.stringify(body),
		},
		{ service: "ha" },
	);
}

/**
 * Pull the JSON-RPC response with the given id out of a Streamable HTTP
 * response body — direct JSON, or SSE-framed data lines. Null if absent.
 */
function parseJsonRpc(text: string, contentType: string, id: number): JsonRpcMessage | null {
	if (contentType.includes("application/json")) {
		try {
			const msg = JSON.parse(text) as JsonRpcMessage;
			return msg.id === id ? msg : null;
		} catch {
			return null;
		}
	}
	if (contentType.includes("text/event-stream")) {
		for (const event of text.split(/\r?\n\r?\n/)) {
			const data = event
				.split(/\r?\n/)
				.filter((l) => l.startsWith("data:"))
				.map((l) => l.slice(5).trim())
				.join("\n");
			if (!data) continue;
			try {
				const msg = JSON.parse(data) as JsonRpcMessage;
				if (msg.id === id) return msg;
			} catch {
				// A non-JSON or unrelated event (pings, notifications) — keep scanning.
			}
		}
	}
	return null;
}

/** A terse status line for the tail + the model when a call goes sideways. */
async function httpFailure(server: McpServer, res: Response): Promise<string> {
	const snippet = (await res.text().catch(() => "")).slice(0, 200);
	if (res.status === 401 || res.status === 403) {
		return `${server.label} rejected the token (${res.status}) — the HA_TOKEN secret is wrong or revoked.`;
	}
	return `${server.label} MCP endpoint answered ${res.status}${snippet ? `: ${snippet}` : ""}.`;
}

/**
 * initialize + notifications/initialized, once per isolate per server.
 * Throws on failure (netted by callMcpTool into is_error).
 */
async function ensureSession(server: McpServer): Promise<Session> {
	const cached = sessions.get(server.url);
	if (cached) return cached;
	const inflight = sessionPromises.get(server.url);
	if (inflight) return inflight;

	const p = (async (): Promise<Session> => {
		const id = ++rpcId;
		const res = await post(server, {
			jsonrpc: "2.0",
			id,
			method: "initialize",
			params: {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "vale-os", version: "1.0" },
			},
		});
		if (!res.ok) throw new Error(await httpFailure(server, res));

		const msg = parseJsonRpc(
			await res.text(),
			res.headers.get("content-type") ?? "",
			id,
		);
		if (!msg || msg.error) {
			throw new Error(
				`${server.label} initialize failed: ${msg?.error?.message ?? "no parseable JSON-RPC response"}.`,
			);
		}
		const session: Session = {
			sessionId: res.headers.get("mcp-session-id"),
			protocolVersion:
				typeof msg.result?.protocolVersion === "string"
					? (msg.result.protocolVersion as string)
					: PROTOCOL_VERSION,
		};

		// The spec's follow-up notification. Best-effort: a server that dislikes it
		// still has our session; one that requires it gets it before any tool call.
		await post(server, { jsonrpc: "2.0", method: "notifications/initialized" }, session).catch(
			() => undefined,
		);

		sessions.set(server.url, session);
		return session;
	})();

	sessionPromises.set(server.url, p);
	try {
		return await p;
	} finally {
		sessionPromises.delete(server.url);
	}
}

/**
 * A liveness/auth check — the Fuse Box keys circuit's test button. Deliberately
 * drops the cached session first: a test must prove the credentials work NOW,
 * not that a handshake once worked. A passing test leaves a fresh session
 * cached, so testing also warms the rail.
 */
export async function pingMcp(server: McpServer): Promise<{ ok: boolean; detail: string }> {
	sessions.delete(server.url);
	try {
		await ensureSession(server);
		return { ok: true, detail: `${server.label} answered the handshake.` };
	} catch (e) {
		return { ok: false, detail: e instanceof Error ? e.message : String(e) };
	}
}

type McpContentBlock = { type?: string; text?: string };

function flattenResult(result: Record<string, unknown>): string {
	const blocks = Array.isArray(result.content) ? (result.content as McpContentBlock[]) : [];
	const texts = blocks
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => (b.text as string).trim())
		.filter(Boolean);
	if (texts.length) return texts.join("\n");
	if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
	return "(the tool ran but returned nothing)";
}

/**
 * Call one named tool on an attached MCP server. The rail's single operation.
 * Always resolves to a ToolResult — see the error contract in the header.
 */
export async function callMcpTool(
	server: McpServer,
	tool: string,
	args: Record<string, unknown>,
): Promise<McpToolResult> {
	try {
		let session = await ensureSession(server);
		const id = ++rpcId;
		const body = {
			jsonrpc: "2.0",
			id,
			method: "tools/call",
			params: { name: tool, arguments: args },
		};

		let res = await post(server, body, session);
		// 404 on a cached session = the server dropped it (spec). 401/403 = the
		// session predates a token rotation (the Fuse Box rotates HA_TOKEN now)
		// and the server invalidated it. Either way: one clean retry with a
		// fresh handshake carrying the current token.
		if ((res.status === 404 || res.status === 401 || res.status === 403) && sessions.has(server.url)) {
			sessions.delete(server.url);
			session = await ensureSession(server);
			res = await post(server, body, session);
		}
		if (!res.ok) return err(await httpFailure(server, res));

		const msg = parseJsonRpc(await res.text(), res.headers.get("content-type") ?? "", id);
		if (!msg) return err(`${server.label} returned no parseable response for ${tool}.`);
		if (msg.error) return err(`${server.label} ${tool}: ${msg.error.message ?? "unknown JSON-RPC error"}`);

		const result = msg.result ?? {};
		const flat = flattenResult(result);
		// An MCP tool error (isError) is still a well-formed result — surface its
		// text as the error message so the model can recover and say so plainly.
		return result.isError === true ? err(flat) : ok(flat);
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		console.log(`MCP rail: ${server.label} ${tool} failed — ${reason}`);
		return err(`Couldn't reach ${server.label}: ${reason}`);
	}
}
