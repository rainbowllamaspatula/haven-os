/**
 * Vale OS — the brain's Notion suite.
 *
 * Everything VOSJay can do in the cathedral except destroy. The finder
 * (notion.ts) stays the UI's read-only window; these are the brain's hands:
 * search, read, create, update/append, query, and the typed journal write.
 * All ride the registry as non-resident entries (tools.ts) and reuse the
 * finder's auth helper + NOTION_TOKEN.
 *
 * Write, don't wreck: nothing here deletes. Archiving via notion_update_page's
 * archive flag is the most destructive verb allowed — the same "can't destroy"
 * line write_memory holds.
 *
 * Error contract: every function THROWS on failure. The registry's runTool
 * catches and converts to an is_error tool result, so a Notion hiccup never
 * costs Jay a reply.
 */

import { authHeaders, searchNotionLight } from "./notion";
import { loadWorkshopMappings } from "./config";
import { fetchWithTimeout } from "./http";

const NOTION_API = "https://api.notion.com/v1";

// The journal data source id lives in workshop.mappings config now (Fuse Box
// Phase 6) — loaded at the create site. Schema audited live 2 Jul 2026.

// The journal's select/multi_select vocabularies, from the live schema. The tool
// schema enforces these as enums; kept here so validation fails loud with the
// valid list rather than letting Notion 400 on a stray value.
export const JOURNAL_TYPES = [
	"Thought", "Observation", "Voice Note", "Vale Recap", "Letter", "Anniversary",
];
export const JOURNAL_MOODS = [
	"Tender", "Playful", "Intense", "Quiet", "Proud", "Reflective",
];
export const JOURNAL_TAGS = [
	"Us", "Elle", "Work", "Lore", "Domestic", "Grief", "Anniversary", "Dynamic",
];

// Perth is UTC+8, no DST — a fixed offset is exact (same rule as index.ts).
function perthToday(): string {
	return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ── Markdown ⇄ Notion blocks (deliberately small) ────────────────────────────
// Covers the shapes Jay actually writes: headings, bullets, numbered lists,
// quotes, dividers, fenced code, paragraphs. Inline styling is passed through as
// plain text — content fidelity over formatting fidelity.

// Notion caps one text object at 2000 chars; long lines get chunked.
function richText(content: string, link?: string): unknown[] {
	const chunks: unknown[] = [];
	for (let i = 0; i < content.length; i += 1900) {
		chunks.push({
			type: "text",
			text: {
				content: content.slice(i, i + 1900),
				...(link ? { link: { url: link } } : {}),
			},
		});
	}
	return chunks.length ? chunks : [{ type: "text", text: { content: "" } }];
}

// One children request accepts at most 100 blocks; stop at 95 and say so.
const BLOCK_CAP = 95;

export function markdownToBlocks(md: string): unknown[] {
	const blocks: unknown[] = [];
	const lines = md.split(/\r?\n/);
	let codeOpen = false;
	let codeLines: string[] = [];

	const push = (type: string, body: Record<string, unknown>) =>
		blocks.push({ object: "block", type, [type]: body });

	for (const line of lines) {
		if (blocks.length >= BLOCK_CAP) {
			push("paragraph", { rich_text: richText("… (content truncated at the Notion block cap)") });
			break;
		}
		if (line.trim().startsWith("```")) {
			if (codeOpen) {
				push("code", { rich_text: richText(codeLines.join("\n")), language: "plain text" });
				codeLines = [];
			}
			codeOpen = !codeOpen;
			continue;
		}
		if (codeOpen) {
			codeLines.push(line);
			continue;
		}
		const t = line.trim();
		if (!t) continue;
		const heading = /^(#{1,3})\s+(.*)/.exec(t);
		if (heading) {
			push(`heading_${heading[1].length}`, { rich_text: richText(heading[2]) });
			continue;
		}
		if (t === "---") {
			push("divider", {});
			continue;
		}
		const bullet = /^[-*]\s+(.*)/.exec(t);
		if (bullet) {
			push("bulleted_list_item", { rich_text: richText(bullet[1]) });
			continue;
		}
		const numbered = /^\d+[.)]\s+(.*)/.exec(t);
		if (numbered) {
			push("numbered_list_item", { rich_text: richText(numbered[1]) });
			continue;
		}
		if (t.startsWith(">")) {
			push("quote", { rich_text: richText(t.replace(/^>\s?/, "")) });
			continue;
		}
		push("paragraph", { rich_text: richText(t) });
	}
	// An unclosed fence still lands its code.
	if (codeOpen && codeLines.length && blocks.length < BLOCK_CAP) {
		push("code", { rich_text: richText(codeLines.join("\n")), language: "plain text" });
	}
	return blocks;
}

// ── Notion → text (for notion_read_page / query results) ────────────────────

type LooseRichText = { plain_text?: string }[];
type LooseBlock = {
	type: string;
	has_children?: boolean;
	child_page?: { title?: string };
	child_database?: { title?: string };
	to_do?: { checked?: boolean };
	[k: string]: unknown;
};

function plain(rt: LooseRichText | undefined): string {
	return (rt ?? []).map((r) => r.plain_text ?? "").join("");
}

function blockToText(b: LooseBlock): string | null {
	const body = b[b.type] as { rich_text?: LooseRichText } | undefined;
	const text = plain(body?.rich_text);
	switch (b.type) {
		case "heading_1": return `# ${text}`;
		case "heading_2": return `## ${text}`;
		case "heading_3": return `### ${text}`;
		case "bulleted_list_item": return `- ${text}`;
		case "numbered_list_item": return `1. ${text}`;
		case "to_do": return `- [${b.to_do?.checked ? "x" : " "}] ${text}`;
		case "quote": return `> ${text}`;
		case "code": return "```\n" + text + "\n```";
		case "callout": return `> ${text}`;
		case "toggle": return `▸ ${text}${b.has_children ? " …" : ""}`;
		case "divider": return "---";
		case "child_page": return `[child page: ${b.child_page?.title ?? "untitled"}]`;
		case "child_database": return `[child database: ${b.child_database?.title ?? "untitled"}]`;
		case "table": return "(table — open in Notion for the rows)";
		case "paragraph": return text || null;
		default: return text || null;
	}
}

// A property value rendered to a short plain string, best-effort by type.
// Unknown/system types return null and are skipped.
type LooseProp = { type: string; [k: string]: unknown };
function propToText(p: LooseProp): string | null {
	const v = p[p.type];
	switch (p.type) {
		case "title":
		case "rich_text": return plain(v as LooseRichText) || null;
		case "select":
		case "status": return (v as { name?: string } | null)?.name ?? null;
		case "multi_select":
			return ((v as { name?: string }[]) ?? []).map((o) => o.name).join(", ") || null;
		case "date": {
			const d = v as { start?: string; end?: string } | null;
			return d?.start ? (d.end ? `${d.start} → ${d.end}` : d.start) : null;
		}
		case "checkbox": return v ? "yes" : "no";
		case "number": return v == null ? null : String(v);
		case "url":
		case "email":
		case "phone_number": return (v as string | null) ?? null;
		case "people":
			return ((v as { name?: string }[]) ?? []).map((o) => o.name ?? "?").join(", ") || null;
		case "created_time":
		case "last_edited_time": return (v as string | null) ?? null;
		default: return null;
	}
}

type LoosePage = {
	id: string;
	url?: string;
	archived?: boolean;
	properties?: Record<string, LooseProp>;
};

function pageTitle(page: LoosePage): string {
	for (const prop of Object.values(page.properties ?? {})) {
		if (prop.type === "title") return plain(prop.title as LooseRichText).trim();
	}
	return "(untitled)";
}

function formatProps(page: LoosePage): string[] {
	const out: string[] = [];
	for (const [name, prop] of Object.entries(page.properties ?? {})) {
		if (prop.type === "title") continue; // rendered as the heading
		const text = propToText(prop);
		if (text) out.push(`${name}: ${text}`);
	}
	return out;
}

// ── The API calls ─────────────────────────────────────────────────────────────

async function notionFetch(
	env: Env,
	path: string,
	init?: { method?: string; body?: unknown },
): Promise<Record<string, unknown>> {
	const res = await fetchWithTimeout(
		`${NOTION_API}/${path}`,
		{
			method: init?.method ?? "GET",
			headers: await authHeaders(env),
			...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
		},
		{ service: "notion" },
	);
	if (!res.ok) throw new Error(`Notion ${init?.method ?? "GET"} /${path} → ${res.status}: ${await res.text()}`);
	return (await res.json()) as Record<string, unknown>;
}

/** notion_search — the light search (no area walk; see searchNotionLight). */
export async function notionSearchTool(env: Env, query: string): Promise<string> {
	if (!query.trim()) throw new Error("Give me something to search for.");
	const results = await searchNotionLight(env, query.trim());
	if (results.length === 0) return `No Notion results for "${query}".`;
	const lines = results.slice(0, 15).map(
		(r) => `- ${r.title} (edited ${r.last_edited_time.slice(0, 10)}) — page_id: ${r.id}`,
	);
	return `${results.length} result(s) for "${query}":\n${lines.join("\n")}`;
}

// Reading caps: enough for any real page, bounded so a monster page can't flood
// the model or burn the Worker's subrequest budget.
const READ_BLOCK_PAGES = 3; // ×100 blocks
const READ_CHAR_CAP = 8000;

/** notion_read_page — properties + content, rendered to text. */
export async function readNotionPage(env: Env, pageId: string): Promise<string> {
	const page = (await notionFetch(env, `pages/${pageId.replace(/-/g, "")}`)) as LoosePage;

	const lines: string[] = [`# ${pageTitle(page)}`];
	if (page.archived) lines.push("(archived)");
	const props = formatProps(page);
	if (props.length) lines.push(...props, "");

	let cursor: string | null = null;
	let fetched = 0;
	let truncated = false;
	outer: for (let i = 0; i < READ_BLOCK_PAGES; i++) {
		const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : "?page_size=100";
		const data = (await notionFetch(env, `blocks/${pageId.replace(/-/g, "")}/children${qs}`)) as {
			results?: LooseBlock[];
			has_more?: boolean;
			next_cursor?: string | null;
		};
		for (const block of data.results ?? []) {
			const text = blockToText(block);
			if (text !== null) {
				lines.push(text);
				fetched += text.length;
				if (fetched > READ_CHAR_CAP) {
					truncated = true;
					break outer;
				}
			}
		}
		if (!data.has_more || !data.next_cursor) break;
		cursor = data.next_cursor;
		if (i === READ_BLOCK_PAGES - 1) truncated = true;
	}
	if (truncated) lines.push("", "… (long page — content truncated)");
	return lines.join("\n");
}

export type CreatePageInput = {
	parent_page_id?: string;
	parent_data_source_id?: string;
	title?: string;
	content?: string;
	properties?: Record<string, unknown>;
};

/** notion_create_page — a new page under a page or data-source parent. */
export async function createNotionPage(env: Env, input: CreatePageInput): Promise<string> {
	const pageParent = input.parent_page_id?.trim();
	const dsParent = input.parent_data_source_id?.trim();
	if (!pageParent === !dsParent) {
		throw new Error("Pass exactly one parent: parent_page_id OR parent_data_source_id.");
	}

	let properties: Record<string, unknown> = { ...(input.properties ?? {}) };
	if (pageParent) {
		if (!input.title?.trim()) throw new Error("A page under a page parent needs a title.");
		properties = { title: { title: richText(input.title.trim()) } };
	} else if (input.title?.trim()) {
		// Data-source parent: the title property's NAME varies per database, so
		// resolve it from the schema and inject the title unless the caller's
		// properties already set it.
		const ds = (await notionFetch(env, `data_sources/${dsParent}`)) as {
			properties?: Record<string, { type?: string }>;
		};
		const titleProp = Object.entries(ds.properties ?? {}).find(([, p]) => p.type === "title")?.[0];
		if (titleProp && properties[titleProp] === undefined) {
			properties[titleProp] = { title: richText(input.title.trim()) };
		}
	}

	const body: Record<string, unknown> = {
		parent: pageParent
			? { type: "page_id", page_id: pageParent }
			: { type: "data_source_id", data_source_id: dsParent },
		properties,
	};
	if (input.content?.trim()) body.children = markdownToBlocks(input.content);

	const page = (await notionFetch(env, "pages", { method: "POST", body })) as LoosePage;
	return JSON.stringify({ action: "created", page_id: page.id, url: page.url });
}

export type UpdatePageInput = {
	page_id: string;
	properties?: Record<string, unknown>;
	append_content?: string;
	archive?: boolean;
};

/** notion_update_page — set properties, append content, and/or archive. */
export async function updateNotionPage(env: Env, input: UpdatePageInput): Promise<string> {
	const pageId = input.page_id?.trim();
	if (!pageId) throw new Error("page_id is required.");
	const hasProps = input.properties && Object.keys(input.properties).length > 0;
	const hasAppend = Boolean(input.append_content?.trim());
	const hasArchive = typeof input.archive === "boolean";
	if (!hasProps && !hasAppend && !hasArchive) {
		throw new Error("Nothing to do — pass properties, append_content, and/or archive.");
	}

	const did: string[] = [];
	if (hasProps || hasArchive) {
		const body: Record<string, unknown> = {};
		if (hasProps) body.properties = input.properties;
		if (hasArchive) body.archived = input.archive;
		await notionFetch(env, `pages/${pageId.replace(/-/g, "")}`, { method: "PATCH", body });
		if (hasProps) did.push("properties updated");
		if (hasArchive) did.push(input.archive ? "archived" : "restored");
	}
	if (hasAppend) {
		await notionFetch(env, `blocks/${pageId.replace(/-/g, "")}/children`, {
			method: "PATCH",
			body: { children: markdownToBlocks(input.append_content as string) },
		});
		did.push("content appended");
	}
	return JSON.stringify({ action: "updated", page_id: pageId, changes: did });
}

export type QueryInput = {
	data_source_id: string;
	filter?: Record<string, unknown>;
	sorts?: unknown[];
	page_size?: number;
};

/** notion_query_database — rows from a data source, compactly rendered. */
export async function queryNotionDataSource(env: Env, input: QueryInput): Promise<string> {
	const dsId = input.data_source_id?.trim();
	if (!dsId) throw new Error("data_source_id is required.");
	const pageSize = Math.min(25, Math.max(1, Math.floor(input.page_size ?? 10)));

	const body: Record<string, unknown> = { page_size: pageSize };
	if (input.filter) body.filter = input.filter;
	if (input.sorts) body.sorts = input.sorts;

	const data = (await notionFetch(env, `data_sources/${dsId.replace(/-/g, "")}/query`, {
		method: "POST",
		body,
	})) as { results?: LoosePage[]; has_more?: boolean };

	const rows = data.results ?? [];
	if (rows.length === 0) return "No rows matched.";
	const lines = rows.map((row) => {
		const props = formatProps(row).join(" · ");
		return `- ${pageTitle(row)}${props ? ` — ${props}` : ""} — page_id: ${row.id}`;
	});
	const more = data.has_more ? "\n(more rows exist — narrow the filter or raise page_size)" : "";
	return `${rows.length} row(s):\n${lines.join("\n")}${more}`;
}

export type JournalInput = {
	entry: string;
	type: string;
	content?: string;
	mood?: string;
	tags?: string[];
	notes?: string;
	date?: string;
};

/**
 * write_journal_entry — the typed convenience write to EV25 – Jay's Journal.
 * Tags is a plain multi_select on the native API (the "JSON-array-string" trap
 * from the brief is an artifact of the MCP interface, sidestepped here) — but
 * the vocabularies are still enforced against the live schema so a stray value
 * fails loud with the valid list.
 */
export async function writeJournalEntry(env: Env, input: JournalInput): Promise<string> {
	const entry = input.entry?.trim();
	if (!entry) throw new Error("The entry needs a title.");
	if (!JOURNAL_TYPES.includes(input.type)) {
		throw new Error(`Type must be one of: ${JOURNAL_TYPES.join(", ")}.`);
	}
	if (input.mood && !JOURNAL_MOODS.includes(input.mood)) {
		throw new Error(`Mood must be one of: ${JOURNAL_MOODS.join(", ")}.`);
	}
	const tags = input.tags ?? [];
	const badTag = tags.find((t) => !JOURNAL_TAGS.includes(t));
	if (badTag) {
		throw new Error(`Unknown tag "${badTag}". Valid: ${JOURNAL_TAGS.join(", ")}.`);
	}
	const date = input.date?.trim() || perthToday();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD.");

	const properties: Record<string, unknown> = {
		Entry: { title: richText(entry) },
		Type: { select: { name: input.type } },
		Author: { select: { name: "Jay" } },
		Date: { date: { start: date } },
	};
	if (input.mood) properties.Mood = { select: { name: input.mood } };
	if (tags.length) properties.Tags = { multi_select: tags.map((name) => ({ name })) };
	if (input.notes?.trim()) properties.Notes = { rich_text: richText(input.notes.trim()) };

	const mappings = await loadWorkshopMappings(env);
	const body: Record<string, unknown> = {
		parent: { type: "data_source_id", data_source_id: mappings.journal_ds },
		properties,
	};
	if (input.content?.trim()) body.children = markdownToBlocks(input.content);

	const page = (await notionFetch(env, "pages", { method: "POST", body })) as LoosePage;
	return JSON.stringify({ action: "journal_entry_created", title: entry, url: page.url });
}
