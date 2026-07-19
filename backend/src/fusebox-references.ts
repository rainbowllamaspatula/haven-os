/**
 * The Fuse Box references circuit — Phase 5 of the v0.3 brief.
 *
 * CRUD over `gallery_references` plus image upload to the refs/ prefix in
 * R2 — the first CODE path that writes refs/ (until now a reference was a
 * manual R2 upload + a hand-inserted row, exactly as the Gallery migration
 * describes). The Gallery's render pass and composer chips read the table
 * live (loadActiveReferences / GET /api/gallery/references), so a reference
 * saved here is generative immediately: rows, not code, never a deploy.
 *
 * The 10 MiB guard moves to the door: getimg caps reference fetches at
 * 10 MiB (learned live 17 Jul — an 11 MB elle.png failed every generation
 * carrying her). The Gallery already checks pre-bill; here we refuse the
 * upload itself, naming the size, so an oversized ref can't even enter the
 * bank. Slugs are immutable once created — the storage path is slug-coupled
 * and prompt canon may reference them; archive and re-create to rename.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** getimg's reference-fetch ceiling — same value gallery.ts enforces pre-bill. */
export const REF_MAX_BYTES = 10 * 1024 * 1024;

export const REF_KINDS = ["character", "location"] as const;

const IMAGE_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
};

export function validateSlug(slug: unknown): { ok: true; slug: string } | { ok: false; error: string } {
	const s = typeof slug === "string" ? slug.trim().toLowerCase() : "";
	if (!s) return { ok: false, error: "slug is required" };
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(s)) {
		return { ok: false, error: "slug must be lowercase letters, digits, - or _ (max 64 chars)" };
	}
	return { ok: true, slug: s };
}

export function validateImage(file: {
	size: number;
	type: string;
}): { ok: true; ext: string } | { ok: false; error: string } {
	const ext = IMAGE_EXT[file.type];
	if (!ext) {
		return { ok: false, error: `unsupported image type "${file.type}" — png, jpeg or webp` };
	}
	if (file.size > REF_MAX_BYTES) {
		return {
			ok: false,
			error: `that image is ${(file.size / (1024 * 1024)).toFixed(1)} MiB — getimg caps reference fetches at 10 MiB; re-export it smaller`,
		};
	}
	if (file.size === 0) return { ok: false, error: "the image is empty" };
	return { ok: true, ext };
}

const COLUMNS = "id, slug, kind, display_name, description, storage_path, active, created_at";

export async function listReferences(supabase: SupabaseClient) {
	const { data, error } = await supabase
		.from("gallery_references")
		.select(COLUMNS)
		.order("kind")
		.order("slug");
	if (error) return { ok: false as const, error: error.message };
	return { ok: true as const, references: data ?? [] };
}

export type RefFields = {
	slug: unknown;
	kind: unknown;
	display_name: unknown;
	description: unknown;
	active?: unknown;
};

/**
 * Create a reference, or replace an existing slug's image/fields. The image
 * lands in R2 BEFORE the row is written (same ordering discipline as voice:
 * a row must never point at an object that isn't there). On an ext change
 * the old object is removed after the row flips to the new path.
 */
export async function upsertReference(
	bucket: R2Bucket,
	supabase: SupabaseClient,
	fields: RefFields,
	image: { bytes: ArrayBuffer; size: number; type: string } | null,
): Promise<{ ok: true; created: boolean; storage_path: string } | { ok: false; error: string }> {
	const slugCheck = validateSlug(fields.slug);
	if (!slugCheck.ok) return slugCheck;
	const kind = typeof fields.kind === "string" ? fields.kind : "";
	if (!REF_KINDS.includes(kind as (typeof REF_KINDS)[number])) {
		return { ok: false, error: `kind must be one of: ${REF_KINDS.join(", ")}` };
	}
	const displayName = typeof fields.display_name === "string" ? fields.display_name.trim() : "";
	const description = typeof fields.description === "string" ? fields.description.trim() : "";
	if (!displayName) return { ok: false, error: "display_name is required" };
	if (!description) {
		return { ok: false, error: "description is required — it is what the render pass weaves into prompts" };
	}

	const { data: existing, error: fetchErr } = await supabase
		.from("gallery_references")
		.select("id, storage_path")
		.eq("slug", slugCheck.slug)
		.maybeSingle();
	if (fetchErr) return { ok: false, error: fetchErr.message };

	// A NEW reference requires an image; editing an existing one may keep its
	// current object and only change the words.
	if (!existing && !image) {
		return { ok: false, error: "a new reference needs an image" };
	}

	let storagePath = existing?.storage_path as string | undefined;
	if (image) {
		const imgCheck = validateImage(image);
		if (!imgCheck.ok) return imgCheck;
		storagePath = `refs/${slugCheck.slug}.${imgCheck.ext}`;
		await bucket.put(storagePath, image.bytes, {
			httpMetadata: { contentType: image.type },
		});
	}

	const row = {
		slug: slugCheck.slug,
		kind,
		display_name: displayName,
		description,
		storage_path: storagePath!,
		active: fields.active !== false && fields.active !== "false",
	};
	const { error: upsertErr } = await supabase
		.from("gallery_references")
		.upsert(row, { onConflict: "slug" });
	if (upsertErr) return { ok: false, error: upsertErr.message };

	// The row now points at the new object; an ext change strands the old one —
	// remove it. (Same-path replacement was an overwrite; nothing to do.)
	if (image && existing?.storage_path && existing.storage_path !== storagePath) {
		await bucket.delete(existing.storage_path).catch(() => undefined);
	}

	return { ok: true, created: !existing, storage_path: storagePath! };
}

/** Text-field/flag edits by id — never touches slug or the image. */
export async function updateReference(
	supabase: SupabaseClient,
	id: string,
	patch: { display_name?: unknown; description?: unknown; active?: unknown; kind?: unknown },
): Promise<{ ok: true } | { ok: false; error: string }> {
	const update: Record<string, unknown> = {};
	if (patch.display_name !== undefined) {
		const v = typeof patch.display_name === "string" ? patch.display_name.trim() : "";
		if (!v) return { ok: false, error: "display_name must not be empty" };
		update.display_name = v;
	}
	if (patch.description !== undefined) {
		const v = typeof patch.description === "string" ? patch.description.trim() : "";
		if (!v) return { ok: false, error: "description must not be empty" };
		update.description = v;
	}
	if (patch.kind !== undefined) {
		if (!REF_KINDS.includes(patch.kind as (typeof REF_KINDS)[number])) {
			return { ok: false, error: `kind must be one of: ${REF_KINDS.join(", ")}` };
		}
		update.kind = patch.kind;
	}
	if (patch.active !== undefined) update.active = patch.active === true;
	if (Object.keys(update).length === 0) return { ok: false, error: "nothing to update" };

	const { error } = await supabase.from("gallery_references").update(update).eq("id", id);
	if (error) return { ok: false, error: error.message };
	return { ok: true };
}

/** Hard delete: row AND the refs/ object, in that order (a dangling object
 *  is tidier than a dangling row). */
export async function deleteReference(
	bucket: R2Bucket,
	supabase: SupabaseClient,
	id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const { data: row, error: fetchErr } = await supabase
		.from("gallery_references")
		.select("storage_path")
		.eq("id", id)
		.maybeSingle();
	if (fetchErr) return { ok: false, error: fetchErr.message };
	if (!row) return { ok: false, error: "no such reference" };
	const { error } = await supabase.from("gallery_references").delete().eq("id", id);
	if (error) return { ok: false, error: error.message };
	if (row.storage_path) await bucket.delete(row.storage_path).catch(() => undefined);
	return { ok: true };
}
