import { describe, it, expect, vi, afterEach } from "vitest";
import {
	validateMemory,
	needsReembed,
	updateMemory,
	createMemory,
	importMemories,
} from "../src/fusebox-memories";
import type { SupabaseClient } from "@supabase/supabase-js";

const ENV = { SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_ROLE_KEY: "svc" } as unknown as Env;

afterEach(() => vi.unstubAllGlobals());

const embedOk = () =>
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 })),
	);
const embedDown = () =>
	vi.stubGlobal("fetch", vi.fn(async () => new Response("embedder on fire", { status: 500 })));

// A recording supabase stub for the memories table: one existing row, and a
// log of every write that reaches the table.
function memoriesDb(existing: Record<string, unknown> | null) {
	const writes: Array<{ kind: string; payload?: unknown }> = [];
	const db = {
		from: () => ({
			select: () => ({
				eq: () => ({
					maybeSingle: async () => ({ data: existing, error: null }),
				}),
			}),
			update: (payload: unknown) => {
				return { eq: async () => (writes.push({ kind: "update", payload }), { error: null }) };
			},
			insert: (payload: unknown) => {
				writes.push({ kind: "insert", payload });
				return { select: () => ({ single: async () => ({ data: { id: "new-id" }, error: null }) }) };
			},
		}),
	} as unknown as SupabaseClient;
	return { db, writes };
}

const EXISTING = {
	id: "m1",
	title: "Robo",
	content: "The robot vacuum.",
	type: "canon",
	category: "systems",
	tags: ["home"],
	entry_date: null,
	core: false,
	active: true,
};

describe("validateMemory", () => {
	it("accepts a clean row with defaults (active true, core false)", () => {
		const v = validateMemory({ title: "T", content: "C", type: "canon", category: "lore" });
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.row).toMatchObject({ active: true, core: false, tags: [] });
	});

	it("rejects unknown types and categories, naming the valid sets", () => {
		const t = validateMemory({ title: "T", content: "C", type: "vibe", category: "lore" });
		expect(t.ok).toBe(false);
		if (!t.ok) expect(t.error).toContain("anchor");
		const c = validateMemory({ title: "T", content: "C", type: "canon", category: "vibes" });
		expect(c.ok).toBe(false);
		if (!c.ok) expect(c.error).toContain("dynamic");
	});

	it("requires entry_date for daily/weekly rows", () => {
		const v = validateMemory({ title: "T", content: "C", type: "daily", category: "general" });
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.error).toContain("entry_date");
	});
});

describe("needsReembed - the title\\ncontent rule", () => {
	it("content change re-embeds", () => {
		expect(needsReembed(EXISTING, { content: "different" })).toBe(true);
	});
	it("TITLE change re-embeds too — the embed input is title\\ncontent", () => {
		expect(needsReembed(EXISTING, { title: "Robo the vacuum" })).toBe(true);
	});
	it("no text change means no re-embed", () => {
		expect(needsReembed(EXISTING, {})).toBe(false);
		expect(needsReembed(EXISTING, { title: "Robo", content: "The robot vacuum." })).toBe(false);
	});
});

describe("updateMemory - embed-first, write-only-on-success", () => {
	it("re-embeds on a content edit and includes the fresh vector in the write", async () => {
		embedOk();
		const { db, writes } = memoriesDb(EXISTING);
		const result = await updateMemory(ENV, db, "m1", { content: "New content." });
		expect(result).toEqual({ ok: true, reembedded: true });
		const update = writes.find((w) => w.kind === "update")?.payload as Record<string, unknown>;
		expect(update.embedding).toBe(JSON.stringify([0.1, 0.2]));
	});

	it("🔴 rejects the save when embedding fails — the old row is untouched", async () => {
		embedDown();
		const { db, writes } = memoriesDb(EXISTING);
		const result = await updateMemory(ENV, db, "m1", { content: "New content." });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("NOT saved");
		expect(writes).toHaveLength(0); // nothing reached the table
	});

	it("a flag-only edit (archive) skips the re-embed and writes no vector", async () => {
		embedDown(); // embedder is DOWN — and the archive must still succeed
		const { db, writes } = memoriesDb(EXISTING);
		const result = await updateMemory(ENV, db, "m1", { active: false });
		expect(result).toEqual({ ok: true, reembedded: false });
		const update = writes.find((w) => w.kind === "update")?.payload as Record<string, unknown>;
		expect(update.embedding).toBeUndefined();
		expect(update.active).toBe(false);
	});

	it("retitling a daily row inherits its entry_date instead of tripping validation", async () => {
		embedOk();
		const daily = { ...EXISTING, type: "daily", entry_date: "2026-07-17" };
		const { db, writes } = memoriesDb(daily);
		const result = await updateMemory(ENV, db, "m1", { title: "Renamed" });
		expect(result.ok).toBe(true);
		const update = writes.find((w) => w.kind === "update")?.payload as Record<string, unknown>;
		expect(update.entry_date).toBe("2026-07-17");
	});
});

describe("createMemory - embed-first on the way in", () => {
	it("inserts with the vector when embedding succeeds", async () => {
		embedOk();
		const { db, writes } = memoriesDb(null);
		const result = await createMemory(ENV, db, {
			title: "T",
			content: "C",
			type: "canon",
			category: "lore",
		});
		expect(result).toEqual({ ok: true, id: "new-id" });
		const insert = writes.find((w) => w.kind === "insert")?.payload as Record<string, unknown>;
		expect(insert.embedding).toBe(JSON.stringify([0.1, 0.2]));
	});

	it("writes nothing when embedding fails", async () => {
		embedDown();
		const { db, writes } = memoriesDb(null);
		const result = await createMemory(ENV, db, {
			title: "T",
			content: "C",
			type: "canon",
			category: "lore",
		});
		expect(result.ok).toBe(false);
		expect(writes).toHaveLength(0);
	});
});

describe("importMemories - per-row failures, never fatal", () => {
	it("reports the malformed row by index and inserts the rest", async () => {
		embedOk();
		const { db } = memoriesDb(null);
		const result = await importMemories(ENV, db, [
			{ title: "Good", content: "C", type: "canon", category: "lore" },
			{ title: "Bad", content: "C", type: "nonsense", category: "lore" },
			{ title: "Also good", content: "C", type: "anchor", category: "people" },
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.report.inserted).toBe(2);
		expect(result.report.failed).toHaveLength(1);
		expect(result.report.failed[0]).toMatchObject({ index: 1, title: "Bad" });
	});

	it("refuses a non-array body outright", async () => {
		const { db } = memoriesDb(null);
		const result = await importMemories(ENV, db, { not: "an array" });
		expect(result.ok).toBe(false);
	});
});
