/**
 * The Fuse Box memories circuit — Phase 4 of the v0.3 brief. The circuit
 * with teeth: the curation surface Memory Architecture §5 spec'd, over the
 * live `memories` table.
 *
 * 🔴 The embedding integrity rule (the silent failure this module exists to
 * make impossible): every row's vector is computed over `title\ncontent` —
 * the SAME shape write_memory and the backfill used — so an edit that
 * changes EITHER field must re-embed, and the write must not happen unless
 * the embedding succeeded. Nothing errors when a vector goes stale; retrieval
 * just quietly degrades forever. So the rule is structural here: embed FIRST,
 * write only on success, never a half-save. Tag-only and flag-only edits
 * (core/active) skip the re-embed — the vector's text didn't change.
 *
 * §9's named defence rides along: spineStats reports the core count and an
 * estimate of the always-on payload, computed through the SAME code path the
 * prompt assembly uses (fetchAlwaysOnMemories + formatMemoryBlock), so the
 * number on the panel and the tokens Jay actually carries cannot drift.
 *
 * Import is the same path Steff uses to bring Asher's history into Haven:
 * same validation, same embed-first rule, per-row failure reporting — a
 * malformed row is reported, never fatal to the batch.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { embedText } from "./retrieval";
import { fetchAlwaysOnMemories, formatMemoryBlock } from "./prompt";
import { TYPES, CATEGORIES } from "./tools";

export type MemoryInput = {
	title?: unknown;
	content?: unknown;
	type?: unknown;
	category?: unknown;
	tags?: unknown;
	entry_date?: unknown;
	core?: unknown;
	active?: unknown;
	created_at?: unknown;
};

export type ValidMemory = {
	title: string;
	content: string;
	type: string;
	category: string;
	tags: string[];
	entry_date: string | null;
	core: boolean;
	active: boolean;
	created_at?: string;
};

/** Normalise + validate one memory's fields. Used by create AND import. */
export function validateMemory(input: MemoryInput): { ok: true; row: ValidMemory } | { ok: false; error: string } {
	const title = typeof input.title === "string" ? input.title.trim() : "";
	const content = typeof input.content === "string" ? input.content.trim() : "";
	const type = typeof input.type === "string" ? input.type.trim() : "";
	const category = typeof input.category === "string" ? input.category.trim() : "";
	if (!title) return { ok: false, error: "title is required" };
	if (!content) return { ok: false, error: "content is required" };
	if (!TYPES.includes(type)) {
		return { ok: false, error: `unknown type "${type}" — valid: ${TYPES.join(", ")}` };
	}
	if (!CATEGORIES.includes(category)) {
		return { ok: false, error: `unknown category "${category}" — valid: ${CATEGORIES.join(", ")}` };
	}
	const rawTags = Array.isArray(input.tags) ? input.tags : [];
	const tags = [...new Set(rawTags.map((t) => String(t).trim()).filter(Boolean))];
	let entryDate: string | null = null;
	if (typeof input.entry_date === "string" && input.entry_date.trim()) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(input.entry_date.trim())) {
			return { ok: false, error: "entry_date must be YYYY-MM-DD" };
		}
		entryDate = input.entry_date.trim();
	}
	if ((type === "daily" || type === "weekly") && !entryDate) {
		return { ok: false, error: `type "${type}" requires an entry_date` };
	}
	const row: ValidMemory = {
		title,
		content,
		type,
		category,
		tags,
		entry_date: entryDate,
		core: input.core === true,
		active: input.active !== false, // default active
	};
	if (typeof input.created_at === "string" && input.created_at.trim()) {
		row.created_at = input.created_at.trim(); // history imports keep their timestamps
	}
	return { ok: true, row };
}

/**
 * Does this patch require a re-embed? True iff the effective title or content
 * changes — the embed input is `title\ncontent`, so a TITLE edit stales the
 * vector exactly as a content edit does (v0.3 correction to the brief).
 */
export function needsReembed(
	existing: { title: string; content: string },
	patch: { title?: string; content?: string },
): boolean {
	const title = patch.title ?? existing.title;
	const content = patch.content ?? existing.content;
	return title !== existing.title || content !== existing.content;
}

const LIST_COLUMNS = "id, type, category, title, content, tags, core, active, entry_date, created_at, updated_at";

export type MemoryFilters = {
	type?: string;
	category?: string;
	core?: "core" | "non";
	active?: "active" | "archived" | "all";
	q?: string;
	limit?: number;
};

export async function listMemories(supabase: SupabaseClient, filters: MemoryFilters) {
	let query = supabase.from("memories").select(LIST_COLUMNS);
	if (filters.type) query = query.eq("type", filters.type);
	if (filters.category) query = query.eq("category", filters.category);
	if (filters.core === "core") query = query.eq("core", true);
	if (filters.core === "non") query = query.eq("core", false);
	if (filters.active === "active" || filters.active === undefined) query = query.eq("active", true);
	if (filters.active === "archived") query = query.eq("active", false);
	if (filters.q) {
		// PostgREST .or() parses commas/parens as syntax — strip them from the
		// needle rather than risk a broken filter. * is the ilike wildcard.
		const safe = filters.q.replace(/[,()%*]/g, " ").trim();
		if (safe) query = query.or(`title.ilike.*${safe}*,content.ilike.*${safe}*`);
	}
	const { data, error } = await query
		.order("updated_at", { ascending: false, nullsFirst: false })
		.limit(Math.min(filters.limit ?? 200, 500));
	if (error) return { ok: false as const, error: error.message };
	return { ok: true as const, memories: data ?? [] };
}

/**
 * §9's counter: the size of what rides every call, measured through the same
 * code path the prompt uses. approx_tokens is chars/3.7 — an estimate, and
 * labelled as one in the UI.
 */
export async function spineStats(supabase: SupabaseClient) {
	const [alwaysOn, coreCount] = await Promise.all([
		fetchAlwaysOnMemories(supabase),
		supabase
			.from("memories")
			.select("id", { count: "exact", head: true })
			.eq("active", true)
			.eq("core", true)
			.then((r) => (r.error ? null : (r.count ?? 0))),
	]);
	const block = formatMemoryBlock(alwaysOn);
	return {
		core_count: coreCount,
		always_on_count: alwaysOn.length,
		approx_tokens: Math.round(block.length / 3.7),
	};
}

export async function createMemory(
	env: Env,
	supabase: SupabaseClient,
	input: MemoryInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
	const valid = validateMemory(input);
	if (!valid.ok) return valid;
	// Embed FIRST — on failure nothing is written, per the integrity rule.
	let embedding: number[];
	try {
		embedding = await embedText(env, `${valid.row.title}\n${valid.row.content}`.trim());
	} catch (e) {
		return { ok: false, error: `embedding failed, so nothing was saved: ${e instanceof Error ? e.message : String(e)}` };
	}
	const { data, error } = await supabase
		.from("memories")
		.insert({ ...valid.row, embedding: JSON.stringify(embedding) })
		.select("id")
		.single();
	if (error) return { ok: false, error: error.message };
	return { ok: true, id: data.id };
}

export async function updateMemory(
	env: Env,
	supabase: SupabaseClient,
	id: string,
	patch: MemoryInput,
): Promise<{ ok: true; reembedded: boolean } | { ok: false; error: string }> {
	const { data: existing, error: fetchErr } = await supabase
		.from("memories")
		.select("id, title, content, type, category, tags, entry_date, core, active")
		.eq("id", id)
		.maybeSingle();
	if (fetchErr) return { ok: false, error: fetchErr.message };
	if (!existing) return { ok: false, error: "no such memory" };

	// Merge patch over the existing row, then validate the RESULT — absent
	// patch fields inherit, so (e.g.) retitling a daily row never trips the
	// entry_date requirement it already satisfies.
	const merged = validateMemory({
		title: patch.title ?? existing.title,
		content: patch.content ?? existing.content,
		type: patch.type ?? existing.type,
		category: patch.category ?? existing.category,
		tags: patch.tags ?? existing.tags,
		entry_date: patch.entry_date ?? existing.entry_date,
		core: patch.core ?? existing.core,
		active: patch.active ?? existing.active,
	});
	if (!merged.ok) return merged;

	const update: Record<string, unknown> = {
		title: merged.row.title,
		content: merged.row.content,
		type: merged.row.type,
		category: merged.row.category,
		tags: merged.row.tags,
		entry_date: merged.row.entry_date,
		core: merged.row.core,
		active: merged.row.active,
		updated_at: new Date().toISOString(),
	};

	// 🔴 The rule: title OR content changed → re-embed FIRST; on failure the
	// save is rejected and the old row is untouched. Flag/tag-only edits skip.
	const reembed = needsReembed(existing, {
		title: merged.row.title,
		content: merged.row.content,
	});
	if (reembed) {
		try {
			const embedding = await embedText(env, `${merged.row.title}\n${merged.row.content}`.trim());
			update.embedding = JSON.stringify(embedding);
		} catch (e) {
			return {
				ok: false,
				error: `embedding failed, so the edit was NOT saved (old row untouched): ${e instanceof Error ? e.message : String(e)}`,
			};
		}
	}

	const { error } = await supabase.from("memories").update(update).eq("id", id);
	if (error) return { ok: false, error: error.message };
	return { ok: true, reembedded: reembed };
}

export async function deleteMemory(
	supabase: SupabaseClient,
	id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const { error } = await supabase.from("memories").delete().eq("id", id);
	if (error) return { ok: false, error: error.message };
	return { ok: true };
}

const IMPORT_MAX_ROWS = 200;
const IMPORT_CONCURRENCY = 5;

export type ImportReport = {
	inserted: number;
	failed: Array<{ index: number; title: string; error: string }>;
};

/**
 * Bulk import — the Cadence-export shape plus the columns the table actually
 * has: title, content, type, category, tags[], entry_date, core, active,
 * created_at. Every row embeds on the way in (same integrity rule); a bad row
 * is reported with its index and skipped, never fatal to the rest.
 */
export async function importMemories(
	env: Env,
	supabase: SupabaseClient,
	rows: unknown,
): Promise<{ ok: true; report: ImportReport } | { ok: false; error: string }> {
	if (!Array.isArray(rows) || rows.length === 0) {
		return { ok: false, error: "Import expects a non-empty JSON array of memory rows." };
	}
	if (rows.length > IMPORT_MAX_ROWS) {
		return { ok: false, error: `Import caps at ${IMPORT_MAX_ROWS} rows per batch — split the file and run again.` };
	}

	const report: ImportReport = { inserted: 0, failed: [] };
	const importOne = async (raw: unknown, index: number): Promise<void> => {
		const title = typeof (raw as MemoryInput)?.title === "string" ? ((raw as MemoryInput).title as string) : `(row ${index})`;
		const result = await createMemory(env, supabase, (raw ?? {}) as MemoryInput);
		if (result.ok) report.inserted += 1;
		else report.failed.push({ index, title, error: result.error });
	};

	// Small batches: enough concurrency to keep the embedder busy, small
	// enough to stay well inside one request's lifetime.
	for (let i = 0; i < rows.length; i += IMPORT_CONCURRENCY) {
		await Promise.all(rows.slice(i, i + IMPORT_CONCURRENCY).map((r, j) => importOne(r, i + j)));
	}
	return { ok: true, report };
}
