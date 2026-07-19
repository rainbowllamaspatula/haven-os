import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
	repairRenderedPrompt,
	startGeneration,
	retryGeneration,
	deleteImage,
	makeThumbnail,
	sweepDeadGenerations,
	capAtSentenceSeam,
	bytesToBase64,
	modelSpec,
	imageKey,
	thumbKey,
	DEFAULT_MODEL_ID,
	PROMPT_MAX_CHARS,
	type GalleryReference,
	type GenerateRequest,
} from "../src/gallery";
import { handleMcp, handleOAuth } from "../src/mcp-server";
import { runTool } from "../src/tools";

// ── Test doubles ──────────────────────────────────────────────────────────────
// A thenable query-builder fake: every chained method returns the builder, and
// awaiting it resolves from the per-test config. Just enough Supabase to pin
// the validation chain — no network, no real client.

type FakeConfig = {
	refs?: GalleryReference[];
	existing?: Record<string, unknown> | null;
	rows?: Record<string, unknown>[];
	pendingCount?: number;
	recentCount?: number;
	insertError?: string | null;
	updateRow?: Record<string, unknown> | null;
	deleteError?: string | null;
};

function fakeSupabase(cfg: FakeConfig = {}) {
	const calls: { table: string; op: string; payload?: unknown }[] = [];
	function builder(table: string) {
		const state = {
			op: "select",
			count: false,
			eqs: [] as [string, unknown][],
			payload: undefined as unknown,
			single: false,
			maybe: false,
		};
		const b: Record<string, unknown> = {};
		const chain = (fn?: (...a: unknown[]) => void) =>
			(...a: unknown[]) => {
				fn?.(...a);
				return b;
			};
		b.select = chain((_cols?: unknown, opts?: unknown) => {
			if ((opts as { count?: string } | undefined)?.count) state.count = true;
		});
		b.eq = chain((col: unknown, v: unknown) => state.eqs.push([String(col), v]));
		b.gt = chain();
		b.lt = chain();
		b.order = chain();
		b.in = chain();
		b.range = chain();
		b.limit = chain();
		b.insert = chain((row: unknown) => {
			state.op = "insert";
			state.payload = row;
		});
		b.update = chain((row: unknown) => {
			state.op = "update";
			state.payload = row;
		});
		b.delete = chain(() => {
			state.op = "delete";
		});
		b.single = chain(() => {
			state.single = true;
		});
		b.maybeSingle = chain(() => {
			state.maybe = true;
		});
		b.then = (resolve: (v: unknown) => unknown) => {
			calls.push({ table, op: state.op, payload: state.payload });
			return Promise.resolve(resolve(resolveQuery(table, state)));
		};
		return b;
	}
	function resolveQuery(
		table: string,
		state: { op: string; count: boolean; eqs: [string, unknown][]; payload: unknown; single: boolean; maybe: boolean },
	) {
		if (table === "gallery_references") return { data: cfg.refs ?? [], error: null };
		if (table === "images") {
			if (state.op === "insert") {
				if (cfg.insertError) return { data: null, error: { message: cfg.insertError } };
				return { data: { ...(state.payload as object), created_at: new Date().toISOString() }, error: null };
			}
			if (state.op === "update") {
				if (state.single) return { data: cfg.updateRow ?? null, error: cfg.updateRow ? null : { message: "0 rows" } };
				return { data: null, error: null };
			}
			if (state.op === "delete") {
				return { data: null, error: cfg.deleteError ? { message: cfg.deleteError } : null };
			}
			if (state.count) {
				const isPending = state.eqs.some(([c, v]) => c === "status" && v === "pending");
				return { count: isPending ? (cfg.pendingCount ?? 0) : (cfg.recentCount ?? 0), error: null };
			}
			if (state.maybe) return { data: cfg.existing ?? null, error: null };
			return { data: cfg.rows ?? [], error: null };
		}
		return { data: null, error: null };
	}
	return { client: builder as unknown as SupabaseClient, from: builder, calls, asClient() { return { from: builder } as unknown as SupabaseClient; } };
}

const LIBRARY: GalleryReference[] = [
	{ slug: "elle", kind: "character", display_name: "Elle", description: "…", storage_path: "refs/elle.png" },
	{ slug: "jay", kind: "character", display_name: "Jay", description: "…", storage_path: "refs/jay.png" },
	{ slug: "kitchen", kind: "location", display_name: "Kitchen", description: "…", storage_path: "refs/kitchen.png" },
	{ slug: "bedroom", kind: "location", display_name: "Bedroom", description: "…", storage_path: "refs/bedroom.png" },
	{ slug: "living-room", kind: "location", display_name: "Living Room", description: "…", storage_path: "refs/living-room.png" },
];

const NB2 = modelSpec(DEFAULT_MODEL_ID)!;
const GOOD_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";

function req(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
	return {
		id: GOOD_ID,
		prompt: "us in the kitchen",
		path: "verbatim",
		source: "elle",
		...overrides,
	};
}

const ENV = { GETIMG_API_KEY: "k" } as unknown as Env;

// ── repairRenderedPrompt — structural enforcement of the render pass ─────────
describe("repairRenderedPrompt", () => {
	it("drops slugs that aren't in the library", () => {
		const out = repairRenderedPrompt(
			{ prompt: "p", reference_slugs: ["elle", "ghost"], aspect_ratio: "1:1" },
			LIBRARY,
			NB2,
		);
		expect(out.reference_slugs).toEqual(["elle"]);
	});

	it("clamps to the model's reference cap", () => {
		const out = repairRenderedPrompt(
			{ prompt: "p", reference_slugs: ["elle", "jay", "kitchen", "bedroom", "living-room"], aspect_ratio: "1:1" },
			LIBRARY,
			NB2,
		);
		expect(out.reference_slugs).toHaveLength(NB2.maxRefs);
	});

	it("required slugs survive ahead of the model's picks", () => {
		const out = repairRenderedPrompt(
			{ prompt: "p", reference_slugs: ["kitchen", "bedroom", "living-room", "jay"], aspect_ratio: "1:1" },
			LIBRARY,
			NB2,
			["elle"],
		);
		expect(out.reference_slugs[0]).toBe("elle");
		expect(out.reference_slugs).toHaveLength(NB2.maxRefs);
	});

	it("falls back on an aspect ratio the model can't produce", () => {
		const out = repairRenderedPrompt(
			{ prompt: "p", reference_slugs: [], aspect_ratio: "7:3" },
			LIBRARY,
			NB2,
			[],
			"16:9",
		);
		expect(out.aspect_ratio).toBe("16:9");
	});

	it("keeps a valid model choice untouched", () => {
		const out = repairRenderedPrompt(
			{ prompt: "p", reference_slugs: ["jay"], aspect_ratio: "2:3" },
			LIBRARY,
			NB2,
		);
		expect(out).toEqual({ prompt: "p", reference_slugs: ["jay"], aspect_ratio: "2:3" });
	});
});

// ── startGeneration — validation before anything billable (Thu's ordering) ───
describe("startGeneration validation", () => {
	it("rejects an empty prompt before anything else", async () => {
		const waitUntil = vi.fn();
		const fake = fakeSupabase();
		const r = await startGeneration(ENV, fake.asClient(), req({ prompt: "   " }), waitUntil);
		expect(r).toMatchObject({ kind: "rejected", status: 400 });
		expect(waitUntil).not.toHaveBeenCalled();
		expect(fake.calls).toHaveLength(0); // not even a DB read
	});

	it("rejects a prompt over the cap", async () => {
		const waitUntil = vi.fn();
		const r = await startGeneration(
			ENV,
			fakeSupabase().asClient(),
			req({ prompt: "x".repeat(PROMPT_MAX_CHARS + 1) }),
			waitUntil,
		);
		expect(r).toMatchObject({ kind: "rejected", status: 400 });
		expect(waitUntil).not.toHaveBeenCalled();
	});

	it("rejects an unknown model", async () => {
		const waitUntil = vi.fn();
		const r = await startGeneration(ENV, fakeSupabase().asClient(), req({ model: "seedream-4" }), waitUntil);
		expect(r).toMatchObject({ kind: "rejected", status: 400 });
		expect(waitUntil).not.toHaveBeenCalled();
	});

	it("rejects a resolution the model doesn't offer", async () => {
		const waitUntil = vi.fn();
		const r = await startGeneration(ENV, fakeSupabase().asClient(), req({ resolution: "8K" }), waitUntil);
		expect(r).toMatchObject({ kind: "rejected", status: 400 });
		expect(waitUntil).not.toHaveBeenCalled();
	});

	it("rejects more references than the model cap, before the refs read", async () => {
		const waitUntil = vi.fn();
		const fake = fakeSupabase({ refs: LIBRARY });
		const r = await startGeneration(
			ENV,
			fake.asClient(),
			req({ reference_slugs: ["elle", "jay", "kitchen", "bedroom", "living-room"] }),
			waitUntil,
		);
		expect(r).toMatchObject({ kind: "rejected", status: 400 });
		expect(fake.calls).toHaveLength(0); // count check is cheaper than the read
		expect(waitUntil).not.toHaveBeenCalled();
	});

	it("rejects unknown or inactive references", async () => {
		const waitUntil = vi.fn();
		const r = await startGeneration(
			ENV,
			fakeSupabase({ refs: LIBRARY }).asClient(),
			req({ reference_slugs: ["elle", "shed"] }),
			waitUntil,
		);
		expect(r).toMatchObject({ kind: "rejected", status: 400 });
		expect((r as { error: string }).error).toContain("shed");
		expect(waitUntil).not.toHaveBeenCalled();
	});

	it("rejects a malformed uuid", async () => {
		const waitUntil = vi.fn();
		const r = await startGeneration(
			ENV,
			fakeSupabase({ refs: LIBRARY }).asClient(),
			req({ id: "not-a-uuid" }),
			waitUntil,
		);
		expect(r).toMatchObject({ kind: "rejected", status: 400 });
		expect(waitUntil).not.toHaveBeenCalled();
	});

	it("idempotency: a known id returns its row without inserting or billing", async () => {
		const waitUntil = vi.fn();
		const fake = fakeSupabase({ refs: LIBRARY, existing: { id: GOOD_ID, status: "complete" } });
		const r = await startGeneration(ENV, fake.asClient(), req(), waitUntil);
		expect(r.kind).toBe("existing");
		expect(fake.calls.some((c) => c.op === "insert")).toBe(false);
		expect(waitUntil).not.toHaveBeenCalled();
	});

	it("rejects 429 when 5 generations are already pending", async () => {
		const waitUntil = vi.fn();
		const r = await startGeneration(
			ENV,
			fakeSupabase({ refs: LIBRARY, pendingCount: 5 }).asClient(),
			req(),
			waitUntil,
		);
		expect(r).toMatchObject({ kind: "rejected", status: 429 });
		expect(waitUntil).not.toHaveBeenCalled();
	});

	it("rejects 429 when the 60s window is full", async () => {
		const waitUntil = vi.fn();
		const r = await startGeneration(
			ENV,
			fakeSupabase({ refs: LIBRARY, recentCount: 20 }).asClient(),
			req(),
			waitUntil,
		);
		expect(r).toMatchObject({ kind: "rejected", status: 429 });
		expect(waitUntil).not.toHaveBeenCalled();
	});

	it("accepts a clean request: pending row inserted, background work scheduled once", async () => {
		const waitUntil = vi.fn();
		const fake = fakeSupabase({ refs: LIBRARY });
		const r = await startGeneration(
			ENV,
			fake.asClient(),
			req({ reference_slugs: ["elle", "jay", "kitchen"], aspect_ratio: "3:2" }),
			waitUntil,
		);
		expect(r.kind).toBe("accepted");
		const insert = fake.calls.find((c) => c.op === "insert");
		expect(insert?.payload).toMatchObject({
			id: GOOD_ID,
			source: "elle",
			status: "pending",
			path: "verbatim",
			prompt_raw: "us in the kitchen",
		});
		expect(waitUntil).toHaveBeenCalledTimes(1);
	});
});

// ── retryGeneration — same id, same ask, same gate ───────────────────────────
describe("retryGeneration", () => {
	const errorRow = {
		id: GOOD_ID,
		source: "vosjay",
		status: "error",
		path: "authored",
		prompt_raw: "us in the kitchen",
		model: DEFAULT_MODEL_ID,
		aspect_ratio: "3:2",
		resolution: "1K",
		reference_images: [{ slug: "elle", role: "reference_image" }],
		conversation_id: null,
	};

	it("refuses to retry a row that isn't an error", async () => {
		const waitUntil = vi.fn();
		const fake = fakeSupabase({ existing: { ...errorRow, status: "complete" } });
		const r = await retryGeneration(ENV, fake.asClient(), GOOD_ID, waitUntil);
		expect(r).toMatchObject({ kind: "rejected", status: 409 });
		expect(waitUntil).not.toHaveBeenCalled();
	});

	it("404s an unknown id", async () => {
		const r = await retryGeneration(ENV, fakeSupabase().asClient(), GOOD_ID, vi.fn());
		expect(r).toMatchObject({ kind: "rejected", status: 404 });
	});

	it("resets an error row to pending and re-schedules the work", async () => {
		const waitUntil = vi.fn();
		const fake = fakeSupabase({
			existing: errorRow,
			refs: LIBRARY,
			updateRow: { ...errorRow, status: "pending", error: null },
		});
		const r = await retryGeneration(ENV, fake.asClient(), GOOD_ID, waitUntil);
		expect(r.kind).toBe("accepted");
		expect(waitUntil).toHaveBeenCalledTimes(1);
	});
});

// ── deleteImage — objects first, row second ──────────────────────────────────
describe("deleteImage", () => {
	const row = {
		id: GOOD_ID,
		storage_path: imageKey(GOOD_ID),
		thumbnail_path: thumbKey(GOOD_ID),
	};

	it("removes both R2 objects and the row", async () => {
		const deleted: unknown[] = [];
		const env = { GALLERY: { delete: async (k: unknown) => void deleted.push(k) } } as unknown as Env;
		const fake = fakeSupabase({ existing: row });
		const r = await deleteImage(env, fake.asClient(), GOOD_ID);
		expect(r).toEqual({ ok: true });
		expect(deleted).toEqual([[imageKey(GOOD_ID), thumbKey(GOOD_ID)]]);
		expect(fake.calls.some((c) => c.op === "delete" && c.table === "images")).toBe(true);
	});

	it("keeps the row when storage refuses (nothing orphans invisibly)", async () => {
		const env = {
			GALLERY: { delete: async () => { throw new Error("r2 down"); } },
		} as unknown as Env;
		const fake = fakeSupabase({ existing: row });
		const r = await deleteImage(env, fake.asClient(), GOOD_ID);
		expect(r).toMatchObject({ ok: false, status: 502 });
		expect(fake.calls.some((c) => c.op === "delete")).toBe(false);
	});

	it("404s an unknown image", async () => {
		const env = { GALLERY: { delete: async () => {} } } as unknown as Env;
		const r = await deleteImage(env, fakeSupabase().asClient(), GOOD_ID);
		expect(r).toMatchObject({ ok: false, status: 404 });
	});
});

// ── bytesToBase64 — the view_gallery eyes' encoding ──────────────────────────
describe("bytesToBase64", () => {
	it("matches btoa on small input", () => {
		const bytes = new TextEncoder().encode("hello gallery");
		expect(bytesToBase64(bytes)).toBe(btoa("hello gallery"));
	});

	it("survives buffers far past the fromCharCode spread limit", () => {
		// 300k bytes — a spread of this would blow the stack; chunking must not.
		const big = new Uint8Array(300_000).map((_, i) => i % 251);
		const out = bytesToBase64(big);
		expect(out.length).toBe(Math.ceil(big.length / 3) * 4);
		// Round-trip a sample to prove fidelity.
		const decoded = Uint8Array.from(atob(out), (c) => c.charCodeAt(0));
		expect(decoded.length).toBe(big.length);
		expect(decoded[299_999]).toBe(big[299_999]);
	});
});

// ── view_gallery — the brain's eyes (via the registry, end to end) ───────────
describe("view_gallery tool", () => {
	const completeRow = {
		id: GOOD_ID,
		source: "vosjay",
		status: "complete",
		path: "authored",
		prompt_raw: "us in the kitchen",
		model: DEFAULT_MODEL_ID,
		cost: 0.08,
		storage_path: imageKey(GOOD_ID),
		thumbnail_path: thumbKey(GOOD_ID),
		created_at: new Date().toISOString(),
	};
	const PNG_BYTES = new TextEncoder().encode("not-a-real-png-but-bytes");

	function envWithObject(found: boolean): Env {
		return {
			GALLERY: {
				get: async () =>
					found
						? {
								httpMetadata: { contentType: "image/webp" },
								arrayBuffer: async () => PNG_BYTES.buffer,
							}
						: null,
			},
		} as unknown as Env;
	}

	it("returns the image as a base64 block for a complete row", async () => {
		const fake = fakeSupabase({ rows: [completeRow] });
		const r = await runTool(envWithObject(true), fake.asClient(), "view_gallery", {});
		expect(r.is_error).toBe(false);
		expect(Array.isArray(r.content)).toBe(true);
		const blocks = r.content as { type: string; source?: { data: string; media_type: string } }[];
		expect(blocks[0].type).toBe("text");
		expect(blocks[1].type).toBe("image");
		expect(blocks[1].source?.media_type).toBe("image/webp");
		expect(blocks[1].source?.data).toBe(bytesToBase64(PNG_BYTES));
	});

	it("names a pending row pending and forbids regenerating, with no image block", async () => {
		const fake = fakeSupabase({ rows: [{ ...completeRow, status: "pending" }], existing: { ...completeRow, status: "pending" } });
		const r = await runTool(envWithObject(true), fake.asClient(), "view_gallery", { id: GOOD_ID });
		expect(r.is_error).toBe(false);
		expect(typeof r.content).toBe("string");
		expect(r.content as string).toContain("pending");
		expect(r.content as string).toContain("Do NOT regenerate");
	});

	it("is honest when the stored object is missing", async () => {
		const fake = fakeSupabase({ rows: [completeRow] });
		const r = await runTool(envWithObject(false), fake.asClient(), "view_gallery", {});
		expect(typeof r.content).toBe("string");
		expect(r.content as string).toContain("missing");
	});
});

// ── capAtSentenceSeam — the render budget's mechanical backstop ──────────────
describe("capAtSentenceSeam", () => {
	it("leaves an in-budget prompt untouched", () => {
		expect(capAtSentenceSeam("A short prompt.", 600)).toBe("A short prompt.");
	});

	it("cuts at the last full sentence under the budget", () => {
		const p = "First sentence stays. Second sentence also stays. Third one is the straw.";
		const out = capAtSentenceSeam(p, 55);
		expect(out).toBe("First sentence stays. Second sentence also stays.");
	});

	it("never leaves a dangling half-word when no sentence seam exists", () => {
		const p = "one two three four five six seven eight nine ten";
		const out = capAtSentenceSeam(p, 20);
		expect(out.length).toBeLessThanOrEqual(20);
		expect(p.startsWith(out)).toBe(true);
		expect(out.endsWith(" ")).toBe(false);
		// The cut lands between words, so the capped text is a clean prefix
		// of whole words.
		expect(p.split(" ")).toEqual(expect.arrayContaining(out.split(" ")));
	});
});

// ── sweepDeadGenerations — the 30s-waitUntil-cap safety net ──────────────────
describe("sweepDeadGenerations", () => {
	const stuckRow = {
		id: GOOD_ID,
		source: "vosjay",
		status: "pending",
		path: "authored",
		prompt_raw: "us in the kitchen",
		model: DEFAULT_MODEL_ID,
		aspect_ratio: "2:3",
		resolution: "1K",
		reference_images: [{ slug: "elle", role: "reference_image" }],
		conversation_id: null,
		attempted_at: new Date(Date.now() - 120_000).toISOString(),
	};

	it("is a quiet no-op when nothing is stuck", async () => {
		const swept = await sweepDeadGenerations(ENV, fakeSupabase({ rows: [] }).asClient());
		expect(swept).toBe(0);
	});

	it("skips a candidate whose claim is lost to another sweep", async () => {
		const fake = fakeSupabase({ rows: [stuckRow], updateRow: null, refs: LIBRARY });
		const swept = await sweepDeadGenerations(ENV, fake.asClient());
		expect(swept).toBe(0);
		// The claim failed, so the refs library — the first step of a real
		// re-drive — must never have been read.
		expect(fake.calls.some((c) => c.table === "gallery_references")).toBe(false);
	});

	it("claims a dead row and re-drives it to a settled state", async () => {
		// Fake env has no GETIMG key, so the re-drive lands on the honest error
		// path — which IS a settled state; the point is the row can't stay
		// pending forever.
		const fake = fakeSupabase({ rows: [stuckRow], updateRow: stuckRow, refs: LIBRARY });
		const swept = await sweepDeadGenerations({} as Env, fake.asClient());
		expect(swept).toBe(1);
		const settled = fake.calls.filter(
			(c) => c.op === "update" && (c.payload as { status?: string })?.status === "error",
		);
		expect(settled.length).toBeGreaterThan(0);
	});
});

// ── makeThumbnail — photon actually runs on workerd ──────────────────────────
describe("makeThumbnail", () => {
	// A valid 1×1 red PNG. Small enough to skip the resize branch — the point
	// is that photon's WASM decodes and re-encodes in this runtime at all.
	const PNG_1PX = Uint8Array.from(
		atob(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		),
		(c) => c.charCodeAt(0),
	);

	it("produces webp bytes from png bytes", async () => {
		const out = await makeThumbnail(PNG_1PX);
		expect(out.length).toBeGreaterThan(0);
		// RIFF....WEBP container magic
		expect(String.fromCharCode(...out.slice(0, 4))).toBe("RIFF");
		expect(String.fromCharCode(...out.slice(8, 12))).toBe("WEBP");
	});
});

// ── handleOAuth — the connector's handshake (claude.ai speaks only OAuth) ────
describe("handleOAuth", () => {
	const env = {
		SESSION_SECRET: "test-session-secret-long-enough",
		VALE_PASSWORD: "swordfish",
		GALLERY_MCP_TOKEN: "sesame-long-token",
	} as unknown as Env;
	const ORIGIN = "https://example-house.test";
	const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

	// A real PKCE pair, computed with the same primitives the server uses.
	const verifier = "test-verifier-string-that-is-long-enough-for-pkce";
	async function challenge(): Promise<string> {
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
		return btoa(String.fromCharCode(...new Uint8Array(digest)))
			.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	}

	async function authorize(password: string, redirect = CALLBACK): Promise<Response> {
		const body = new URLSearchParams({
			response_type: "code",
			client_id: "vale-os-gallery",
			redirect_uri: redirect,
			state: "st4te",
			code_challenge: await challenge(),
			code_challenge_method: "S256",
			password,
		});
		return handleOAuth(
			new Request(`${ORIGIN}/oauth/authorize`, { method: "POST", body: body.toString() }),
			env,
		);
	}

	it("serves both discovery documents, bare and resource-suffixed", async () => {
		for (const p of [
			"/.well-known/oauth-protected-resource",
			"/.well-known/oauth-protected-resource/mcp",
		]) {
			const res = await handleOAuth(new Request(`${ORIGIN}${p}`), env);
			const body = (await res.json()) as { resource: string };
			expect(body.resource).toBe(`${ORIGIN}/mcp`);
		}
		const as = await handleOAuth(
			new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
			env,
		);
		const meta = (await as.json()) as { token_endpoint: string; code_challenge_methods_supported: string[] };
		expect(meta.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
		expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
	});

	it("refuses a redirect_uri off the allowlist before any password is asked", async () => {
		const res = await authorize("swordfish", "https://evil.example/callback");
		expect(res.status).toBe(400);
	});

	it("wrong house password re-serves the page, mints nothing", async () => {
		const res = await authorize("not-it");
		expect(res.status).toBe(401);
		expect(await res.text()).toContain("not the house password");
	});

	it("full exchange: password → code → PKCE-verified tokens that open /mcp", async () => {
		const authz = await authorize("swordfish");
		expect(authz.status).toBe(302);
		const loc = new URL(authz.headers.get("Location")!);
		expect(loc.origin + loc.pathname).toBe(CALLBACK);
		expect(loc.searchParams.get("state")).toBe("st4te");
		const code = loc.searchParams.get("code")!;

		const tokenRes = await handleOAuth(
			new Request(`${ORIGIN}/oauth/token`, {
				method: "POST",
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code,
					redirect_uri: CALLBACK,
					code_verifier: verifier,
					client_id: "vale-os-gallery",
				}).toString(),
			}),
			env,
		);
		expect(tokenRes.status).toBe(200);
		const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string };

		// The minted access token opens the /mcp door like the static bearer does.
		const ping = await handleMcp(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: { Authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
			}),
			env,
			{ waitUntil: () => {} } as unknown as ExecutionContext,
		);
		expect(ping.status).toBe(200);

		// And the refresh grant issues a fresh access token.
		const refreshed = await handleOAuth(
			new Request(`${ORIGIN}/oauth/token`, {
				method: "POST",
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: tokens.refresh_token,
				}).toString(),
			}),
			env,
		);
		expect(refreshed.status).toBe(200);
	});

	it("rejects the exchange when the PKCE verifier is wrong", async () => {
		const authz = await authorize("swordfish");
		const code = new URL(authz.headers.get("Location")!).searchParams.get("code")!;
		const tokenRes = await handleOAuth(
			new Request(`${ORIGIN}/oauth/token`, {
				method: "POST",
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code,
					redirect_uri: CALLBACK,
					code_verifier: "a-different-verifier-entirely-not-the-real-one",
				}).toString(),
			}),
			env,
		);
		expect(tokenRes.status).toBe(400);
	});

	it("rejects a forged or mangled token at /mcp with the discovery pointer", async () => {
		const res = await handleMcp(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: { Authorization: "Bearer fake.token", "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
			}),
			env,
			{ waitUntil: () => {} } as unknown as ExecutionContext,
		);
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain("oauth-protected-resource");
	});
});

// ── handleMcp — the third door's own lock ────────────────────────────────────
describe("handleMcp", () => {
	const env = { GALLERY_MCP_TOKEN: "sesame-long-token" } as unknown as Env;
	const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
	const post = (body: unknown, token?: string) =>
		new Request("https://example-house.test/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(body),
		});

	it("503s plainly when the token secret isn't set", async () => {
		const res = await handleMcp(post({ method: "ping" }), {} as Env, ctx);
		expect(res.status).toBe(503);
	});

	it("401s a missing or wrong bearer", async () => {
		expect((await handleMcp(post({ method: "ping" }), env, ctx)).status).toBe(401);
		expect((await handleMcp(post({ method: "ping" }, "wrong"), env, ctx)).status).toBe(401);
	});

	it("initializes with tool capability", async () => {
		const res = await handleMcp(
			post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "sesame-long-token"),
			env,
			ctx,
		);
		const body = (await res.json()) as { result: { serverInfo: { name: string } } };
		expect(body.result.serverInfo.name).toBe("vale-os-gallery");
	});

	it("lists exactly the two tools", async () => {
		const res = await handleMcp(
			post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "sesame-long-token"),
			env,
			ctx,
		);
		const body = (await res.json()) as { result: { tools: { name: string }[] } };
		expect(body.result.tools.map((t) => t.name)).toEqual(["generate_image", "list_recent_images"]);
	});

	it("answers an unknown method with a JSON-RPC error, not a crash", async () => {
		const res = await handleMcp(
			post({ jsonrpc: "2.0", id: 3, method: "resources/list" }, "sesame-long-token"),
			env,
			ctx,
		);
		const body = (await res.json()) as { error: { code: number } };
		expect(body.error.code).toBe(-32601);
	});
});
