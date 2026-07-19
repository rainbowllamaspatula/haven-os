import { describe, it, expect } from "vitest";
import {
	validateSlug,
	validateImage,
	upsertReference,
	REF_MAX_BYTES,
} from "../src/fusebox-references";
import type { SupabaseClient } from "@supabase/supabase-js";

// Recording stubs: an R2 bucket and a gallery_references table.
function bucketStub() {
	const ops: Array<{ op: string; key: string }> = [];
	return {
		ops,
		bucket: {
			put: async (key: string) => (ops.push({ op: "put", key }), undefined),
			delete: async (key: string) => (ops.push({ op: "delete", key }), undefined),
		} as unknown as R2Bucket,
	};
}
function refsDb(existing: { id: string; storage_path: string } | null) {
	const writes: Array<{ kind: string; payload?: unknown }> = [];
	const db = {
		from: () => ({
			select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: existing, error: null }) }) }),
			upsert: async (payload: unknown) => (writes.push({ kind: "upsert", payload }), { error: null }),
		}),
	} as unknown as SupabaseClient;
	return { db, writes };
}

const FIELDS = {
	slug: "test-ref",
	kind: "character",
	display_name: "Test",
	description: "A prose canon block.",
};
const png = (size: number) => ({ bytes: new ArrayBuffer(8), size, type: "image/png" });

describe("validateSlug", () => {
	it("normalises case and accepts the house shape", () => {
		expect(validateSlug("Elle-Wrist_Tattoo")).toEqual({ ok: true, slug: "elle-wrist_tattoo" });
	});
	it("rejects spaces, empties, and leading punctuation", () => {
		for (const bad of ["", "two words", "-leading", "sneaky/slash"]) {
			expect(validateSlug(bad).ok).toBe(false);
		}
	});
});

describe("validateImage - the 10 MiB door", () => {
	it("accepts a png under the cap", () => {
		expect(validateImage({ size: 1024, type: "image/png" })).toEqual({ ok: true, ext: "png" });
	});
	it("refuses an 11 MiB image, naming the size", () => {
		const v = validateImage({ size: 11 * 1024 * 1024, type: "image/png" });
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.error).toContain("11.0 MiB");
	});
	it("the cap matches gallery.ts's pre-bill check exactly", () => {
		expect(REF_MAX_BYTES).toBe(10 * 1024 * 1024);
	});
	it("refuses non-image types", () => {
		expect(validateImage({ size: 10, type: "application/pdf" }).ok).toBe(false);
	});
});

describe("upsertReference - image before row, by ordering", () => {
	it("a new reference without an image is refused before anything happens", async () => {
		const { bucket, ops } = bucketStub();
		const { db, writes } = refsDb(null);
		const result = await upsertReference(bucket, db, FIELDS, null);
		expect(result.ok).toBe(false);
		expect(ops).toHaveLength(0);
		expect(writes).toHaveLength(0);
	});

	it("creates: R2 put lands BEFORE the row upsert, path is refs/<slug>.<ext>", async () => {
		const { bucket, ops } = bucketStub();
		const { db, writes } = refsDb(null);
		const result = await upsertReference(bucket, db, FIELDS, png(1024));
		expect(result).toMatchObject({ ok: true, created: true, storage_path: "refs/test-ref.png" });
		expect(ops[0]).toEqual({ op: "put", key: "refs/test-ref.png" });
		expect(writes[0].kind).toBe("upsert");
	});

	it("an oversized image never reaches R2 or the table", async () => {
		const { bucket, ops } = bucketStub();
		const { db, writes } = refsDb(null);
		const result = await upsertReference(bucket, db, FIELDS, png(REF_MAX_BYTES + 1));
		expect(result.ok).toBe(false);
		expect(ops).toHaveLength(0);
		expect(writes).toHaveLength(0);
	});

	it("replacing with a different ext removes the stranded old object AFTER the row flips", async () => {
		const { bucket, ops } = bucketStub();
		const { db } = refsDb({ id: "r1", storage_path: "refs/test-ref.jpg" });
		const result = await upsertReference(bucket, db, FIELDS, png(1024));
		expect(result).toMatchObject({ ok: true, created: false, storage_path: "refs/test-ref.png" });
		expect(ops).toEqual([
			{ op: "put", key: "refs/test-ref.png" },
			{ op: "delete", key: "refs/test-ref.jpg" },
		]);
	});

	it("editing words only (existing row, no image) keeps the current object", async () => {
		const { bucket, ops } = bucketStub();
		const { db, writes } = refsDb({ id: "r1", storage_path: "refs/test-ref.png" });
		const result = await upsertReference(bucket, db, { ...FIELDS, description: "New canon." }, null);
		expect(result).toMatchObject({ ok: true, created: false, storage_path: "refs/test-ref.png" });
		expect(ops).toHaveLength(0);
		expect(writes).toHaveLength(1);
	});
});
