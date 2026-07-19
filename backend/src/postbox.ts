/**
 * Post Box — the mail room's data layer.
 *
 * The whole engine rests on one idea (Mail Client Scoping Notes): a "view" is NOT
 * a Vale-side construct — it's a Gmail label. Sorting mail = writing a Gmail label;
 * the room's views are label queries against Gmail. Gmail stays source of truth,
 * no mirror. The labels Notion Mail already wrote mean the room opens day one onto
 * real organisation.
 *
 * Filters, not folders: a message carries any number of labels at once, so it
 * shows in every matching view, and every row renders all the views it's in. A
 * wrong sort is clutter, not loss — the mail is still in Inbox regardless.
 *
 * Grounded against the live account at build (27 Jun): 12 of 13 buckets already
 * exist as user labels; "Money" reads/writes the existing "Financial Updates"
 * label (Elle's call), and "Promotions" maps to Gmail's native category, never a
 * custom label.
 */

import {
	gmailGet,
	gmailPost,
	gmailPut,
	gmailDelete,
	header,
	parseFrom,
	parseAddress,
	b64urlEncode,
	b64urlDecode,
	type GmailMessage,
	type GmailPart,
} from "./gmail";
import { fetchWithTimeout } from "./http";
import { getSecret } from "./secrets";
import { loadWorkshopMappings } from "./config";

// ── The 14 views ────────────────────────────────────────────────────────────
// `gmail` is what each view resolves to: a system label id (INBOX,
// CATEGORY_PROMOTIONS) used directly, or a user-label NAME resolved to its id at
// runtime (label ids like "Label_122" are opaque and not worth hardcoding). Order
// here is the chip-row order. `kind` is how the labelling Worker decides the view
// — purely informational for the room.
export type ViewKind = "master" | "sender" | "content" | "lifecycle" | "fallback" | "category";
type ViewDef = { key: string; label: string; gmail: { system: string } | { name: string }; kind: ViewKind };

export const VIEWS: ViewDef[] = [
	{ key: "inbox", label: "Inbox", gmail: { system: "INBOX" }, kind: "master" },
	{ key: "ai", label: "AI", gmail: { name: "AI" }, kind: "content" },
	{ key: "personal", label: "Personal", gmail: { name: "Personal" }, kind: "fallback" },
	// Elle's call (27 Jun): the chip reads "Money", the label stays "Financial Updates".
	{ key: "money", label: "Money", gmail: { name: "Financial Updates" }, kind: "content" },
	{ key: "health", label: "Health", gmail: { name: "Health" }, kind: "content" },
	{ key: "receipts", label: "Receipts", gmail: { name: "Receipts" }, kind: "lifecycle" },
	{ key: "house_stuff", label: "House Stuff", gmail: { name: "House Stuff" }, kind: "content" },
	{ key: "travel", label: "Travel", gmail: { name: "Travel" }, kind: "content" },
	{ key: "completed_travel", label: "Completed Travel", gmail: { name: "Completed Travel" }, kind: "lifecycle" },
	{ key: "book_stuff", label: "Book Stuff", gmail: { name: "Book Stuff" }, kind: "content" },
	{ key: "jon", label: "Jon", gmail: { name: "Jon" }, kind: "sender" },
	{ key: "cold_outreach", label: "Cold outreach", gmail: { name: "Cold outreach" }, kind: "sender" },
	{ key: "work", label: "Work", gmail: { name: "Work" }, kind: "sender" },
	// Gmail's built-in Promotions category (Elle's call) — never a custom label,
	// so the Worker never has to maintain it.
	{ key: "promotions", label: "Promotions", gmail: { system: "CATEGORY_PROMOTIONS" }, kind: "category" },
];

const VIEW_BY_KEY = new Map(VIEWS.map((v) => [v.key, v]));

// ── Label name → id resolver (cached per isolate) ───────────────────────────
// labels.list is the only place name↔id lives; structure is effectively static,
// so one fetch per isolate covers every view.
type LabelInfo = { id: string; name: string };
let labelCache: { byName: Map<string, string>; byId: Map<string, ViewDef> } | null = null;

async function loadLabels(env: Env): Promise<{ byName: Map<string, string>; byId: Map<string, ViewDef> }> {
	if (labelCache) return labelCache;
	const data = (await gmailGet(env, "/labels")) as { labels?: LabelInfo[] };
	const byName = new Map<string, string>();
	for (const l of data.labels ?? []) byName.set(l.name, l.id);

	// view key ← gmail label id, so a message's labelIds map back to the views
	// it belongs to (drives the row's label chips). System-id views included.
	const byId = new Map<string, ViewDef>();
	for (const v of VIEWS) {
		const id = "system" in v.gmail ? v.gmail.system : byName.get(v.gmail.name);
		if (id) byId.set(id, v);
	}
	labelCache = { byName, byId };
	return labelCache;
}

/** The Gmail label id a view resolves to, or null if its user-label is missing. */
async function viewLabelId(env: Env, key: string): Promise<string | null> {
	const v = VIEW_BY_KEY.get(key);
	if (!v) return null;
	if ("system" in v.gmail) return v.gmail.system;
	const { byName } = await loadLabels(env);
	return byName.get(v.gmail.name) ?? null;
}

// ── Message shapes the room renders ─────────────────────────────────────────
/** One list row: headers + snippet + which views it's in. Never the body. */
export type PostBoxRow = {
	id: string;
	threadId: string;
	messageId: string | null; // RFC822 Message-ID (deep-link via rfc822msgid:)
	from: string;
	fromAddress: string;
	subject: string;
	snippet: string;
	unread: boolean;
	starred: boolean; // the Gmail STARRED label — a manual "keep in inbox" pin
	date: string | null;
	views: string[]; // view keys this message is labelled into (excl. inbox/system)
};

/** The read view: a row plus the rendered body, recipients, and label state. */
export type PostBoxMessage = PostBoxRow & {
	to: string;
	cc: string;
	bodyHtml: string | null;
	bodyText: string | null;
};

// Which view keys a message's labelIds map to — the chips on its row. The master
// Inbox and the Promotions *category* aren't shown as chips (every message is in
// inbox; the category is noise), but real filing labels are.
async function viewsFor(env: Env, labelIds: string[]): Promise<string[]> {
	const { byId } = await loadLabels(env);
	const keys: string[] = [];
	for (const id of labelIds) {
		const v = byId.get(id);
		if (v && v.kind !== "master" && v.kind !== "category") keys.push(v.key);
	}
	return keys;
}

/** Metadata-only fetch (list rows): headers + snippet + label membership. */
async function fetchRow(env: Env, id: string): Promise<PostBoxRow> {
	const m = (await gmailGet(
		env,
		`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`,
	)) as GmailMessage;
	const headers = m.payload?.headers ?? [];
	const iso = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null;
	const rawMessageId = header(headers, "Message-ID").replace(/^<|>$/g, "").trim();
	const fromRaw = header(headers, "From");
	return {
		id: m.id,
		threadId: m.threadId,
		messageId: rawMessageId || null,
		from: parseFrom(fromRaw) || "(unknown sender)",
		fromAddress: parseAddress(fromRaw),
		subject: header(headers, "Subject") || "(no subject)",
		snippet: m.snippet ?? "",
		unread: (m.labelIds ?? []).includes("UNREAD"),
		starred: (m.labelIds ?? []).includes("STARRED"),
		date: iso,
		views: await viewsFor(env, m.labelIds ?? []),
	};
}

const LIST_MAX = 30;

/** The mail list for one view (label-filtered, newest-first). */
export async function getMessages(env: Env, viewKey: string): Promise<{ messages: PostBoxRow[] }> {
	const labelId = await viewLabelId(env, viewKey);
	if (!labelId) return { messages: [] }; // a view whose label doesn't exist yet
	const list = (await gmailGet(env, `/messages?labelIds=${encodeURIComponent(labelId)}&maxResults=${LIST_MAX}`)) as {
		messages?: { id: string }[];
	};
	const ids = (list.messages ?? []).map((m) => m.id);
	// One flaky metadata fetch shouldn't blank the whole list — keep the rows that
	// loaded, log the ones that didn't.
	const settled = await Promise.allSettled(ids.map((id) => fetchRow(env, id)));
	const messages = settled
		.filter((r): r is PromiseFulfilledResult<PostBoxRow> => r.status === "fulfilled")
		.map((r) => r.value);
	const failed = settled.length - messages.length;
	if (failed) console.log(`getMessages(${viewKey}): ${failed}/${settled.length} rows failed to load`);
	return { messages };
}

// ── The view chips (with unread counts) ─────────────────────────────────────
export type ViewChip = { key: string; label: string; kind: ViewKind; unread: number };

/** Every view, in order, with its true unread count for the chip badges, plus a
 * total draft count for the Drafts chip (drafts aren't a view — they're the DRAFT
 * system label — but the room surfaces them right alongside). */
export async function getViews(env: Env): Promise<{ views: ViewChip[]; draftCount: number }> {
	const { byName } = await loadLabels(env);
	const [chips, draftLabel] = await Promise.all([
		Promise.all(
			VIEWS.map(async (v): Promise<ViewChip> => {
				const id = "system" in v.gmail ? v.gmail.system : byName.get(v.gmail.name);
				let unread = 0;
				if (id) {
					try {
						const lbl = (await gmailGet(env, `/labels/${encodeURIComponent(id)}`)) as {
							messagesUnread?: number;
						};
						unread = lbl.messagesUnread ?? 0;
					} catch {
						unread = 0; // a missing/odd label never blanks the whole row
					}
				}
				return { key: v.key, label: v.label, kind: v.kind, unread };
			}),
		),
		gmailGet(env, "/labels/DRAFT").catch(() => ({})) as Promise<{ messagesTotal?: number }>,
	]);
	return { views: chips, draftCount: draftLabel.messagesTotal ?? 0 };
}

// ── Read view: full message with a rendered body ────────────────────────────
// Walk the MIME tree for the best body part. Prefer text/html (rendered in a
// sandboxed iframe client-side), keep text/plain as the fallback. Attachments and
// nested multiparts are skipped — v1 shows the message, not its enclosures.
function findBody(part: GmailPart | undefined, want: string): string | null {
	if (!part) return null;
	if (part.mimeType === want && part.body?.data) {
		return new TextDecoder().decode(b64urlDecode(part.body.data));
	}
	for (const child of part.parts ?? []) {
		const found = findBody(child, want);
		if (found) return found;
	}
	return null;
}

/** One message in full — body, recipients, labels — for the read view. */
export async function getMessage(env: Env, id: string): Promise<PostBoxMessage> {
	const m = (await gmailGet(env, `/messages/${id}?format=full`)) as GmailMessage;
	const headers = m.payload?.headers ?? [];
	const iso = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null;
	const rawMessageId = header(headers, "Message-ID").replace(/^<|>$/g, "").trim();
	const fromRaw = header(headers, "From");
	return {
		id: m.id,
		threadId: m.threadId,
		messageId: rawMessageId || null,
		from: parseFrom(fromRaw) || "(unknown sender)",
		fromAddress: parseAddress(fromRaw),
		subject: header(headers, "Subject") || "(no subject)",
		snippet: m.snippet ?? "",
		unread: (m.labelIds ?? []).includes("UNREAD"),
		starred: (m.labelIds ?? []).includes("STARRED"),
		date: iso,
		views: await viewsFor(env, m.labelIds ?? []),
		to: header(headers, "To"),
		cc: header(headers, "Cc"),
		bodyHtml: findBody(m.payload, "text/html"),
		bodyText: findBody(m.payload, "text/plain"),
	};
}

/** Star / unstar a message — the manual "keep this in the inbox" pin the
 * auto-archive sweep spares. Toggles the Gmail STARRED label. */
export async function setStar(env: Env, id: string, starred: boolean): Promise<void> {
	await gmailPost(env, `/messages/${id}/modify`, {
		[starred ? "addLabelIds" : "removeLabelIds"]: ["STARRED"],
	});
}

// ── Triage: relabel + read-state ────────────────────────────────────────────
/** Add/remove views on a message (the relabel mechanism). Keys → label ids. */
export async function modifyLabels(
	env: Env,
	id: string,
	addKeys: string[],
	removeKeys: string[],
): Promise<{ views: string[] }> {
	const resolve = async (keys: string[]) =>
		(await Promise.all(keys.map((k) => viewLabelId(env, k)))).filter((x): x is string => !!x);
	const addLabelIds = await resolve(addKeys);
	const removeLabelIds = await resolve(removeKeys);
	const m = (await gmailPost(env, `/messages/${id}/modify`, { addLabelIds, removeLabelIds })) as GmailMessage;
	return { views: await viewsFor(env, m.labelIds ?? []) };
}

/** Mark a message read (drop UNREAD) — done on open. Best-effort. */
export async function markRead(env: Env, id: string): Promise<void> {
	await gmailPost(env, `/messages/${id}/modify`, { removeLabelIds: ["UNREAD"] });
}

/** Archive (drop INBOX) or trash a message — the read view's triage buttons. */
export async function archiveMessage(env: Env, id: string): Promise<void> {
	await gmailPost(env, `/messages/${id}/modify`, { removeLabelIds: ["INBOX"] });
}
export async function trashMessage(env: Env, id: string): Promise<void> {
	await gmailPost(env, `/messages/${id}/trash`, {});
}

// ── Compose: send + draft ───────────────────────────────────────────────────
// The authenticated address, for the From header. Fetched once per isolate.
let profileEmail: string | null = null;
async function fromAddress(env: Env): Promise<string> {
	if (profileEmail) return profileEmail;
	const p = (await gmailGet(env, "/profile")) as { emailAddress?: string };
	profileEmail = p.emailAddress ?? "me";
	return profileEmail;
}

export type Compose = {
	to: string;
	cc?: string;
	subject: string;
	body: string;
	// Reply threading: the original RFC822 Message-ID + the thread to attach to.
	inReplyTo?: string | null;
	threadId?: string | null;
	// When the message was opened from an existing draft: the draft to clear on
	// send (so sending a draft doesn't leave the draft behind).
	draftId?: string | null;
};

// Collapse any CR/LF out of a value bound for a header line. Without this, a
// newline smuggled into to/cc/subject (or a crafted Message-ID) injects extra
// RFC822 headers — e.g. a silent Bcc — into mail sent from Elle's real account.
// The body is deliberately NOT run through this: line breaks there are content.
function headerSafe(v: string): string {
	return v.replace(/[\r\n]+/g, " ");
}

// Build a minimal RFC822 message. v1 is plain text/UTF-8 (the compose surface is
// plain text; rich formatting is a later pass). Header values are kept to one line.
function buildRaw(from: string, c: Compose): string {
	const lines = [
		`From: ${headerSafe(from)}`,
		`To: ${headerSafe(c.to)}`,
		...(c.cc ? [`Cc: ${headerSafe(c.cc)}`] : []),
		`Subject: ${headerSafe(c.subject)}`,
		"MIME-Version: 1.0",
		'Content-Type: text/plain; charset="UTF-8"',
		"Content-Transfer-Encoding: 8bit",
	];
	if (c.inReplyTo) {
		const raw = c.inReplyTo.startsWith("<") ? c.inReplyTo : `<${c.inReplyTo}>`;
		const mid = headerSafe(raw);
		lines.push(`In-Reply-To: ${mid}`, `References: ${mid}`);
	}
	const mime = `${lines.join("\r\n")}\r\n\r\n${c.body}`;
	return b64urlEncode(new TextEncoder().encode(mime));
}

/** Send a message (or reply, threaded). Every send is Elle-confirmed in the UI. */
export async function sendMail(env: Env, c: Compose): Promise<{ id: string; threadId: string }> {
	const raw = buildRaw(await fromAddress(env), c);
	const body: Record<string, unknown> = { raw };
	if (c.threadId) body.threadId = c.threadId;
	const r = (await gmailPost(env, "/messages/send", body)) as { id: string; threadId: string };
	// Sending from an opened draft clears that draft — best-effort, never costs
	// the send.
	if (c.draftId) await deleteDraft(env, c.draftId).catch(() => {});
	return r;
}

/** Save a draft (closing a half-written message — never binned). */
export async function saveDraft(env: Env, c: Compose): Promise<{ draftId: string }> {
	const raw = buildRaw(await fromAddress(env), c);
	const body: Record<string, unknown> = { message: { raw } };
	if (c.threadId) (body.message as Record<string, unknown>).threadId = c.threadId;
	const r = (await gmailPost(env, "/drafts", body)) as { id: string };
	return { draftId: r.id };
}

/** Update an existing draft in place — so re-closing a reopened draft doesn't
 * spawn a duplicate every time. */
export async function updateDraft(env: Env, draftId: string, c: Compose): Promise<{ draftId: string }> {
	const raw = buildRaw(await fromAddress(env), c);
	const message: Record<string, unknown> = { raw };
	if (c.threadId) message.threadId = c.threadId;
	const r = (await gmailPut(env, `/drafts/${draftId}`, { message })) as { id: string };
	return { draftId: r.id };
}

/** Discard a draft. */
export async function deleteDraft(env: Env, draftId: string): Promise<void> {
	await gmailDelete(env, `/drafts/${draftId}`);
}

/** One editable draft, parsed back into compose fields. */
export type DraftRow = {
	draftId: string;
	to: string;
	subject: string;
	snippet: string;
	body: string;
	threadId: string | null;
	inReplyTo: string | null;
	date: string | null;
};

/** The drafts list — each parsed enough to reopen in the compose surface. */
export async function getDrafts(env: Env): Promise<{ drafts: DraftRow[] }> {
	const list = (await gmailGet(env, "/drafts?maxResults=30")) as {
		drafts?: { id: string; message: { id: string } }[];
	};
	const items = list.drafts ?? [];
	// Keep the drafts that parsed; a single bad one shouldn't blank the list.
	const settled = await Promise.allSettled(
		items.map(async (d): Promise<DraftRow> => {
			const full = (await gmailGet(env, `/drafts/${d.id}?format=full`)) as {
				id: string;
				message: GmailMessage;
			};
			const m = full.message;
			const headers = m.payload?.headers ?? [];
			return {
				draftId: full.id,
				to: header(headers, "To"),
				subject: header(headers, "Subject"),
				snippet: m.snippet ?? "",
				body: findBody(m.payload, "text/plain") ?? findBody(m.payload, "text/html") ?? "",
				threadId: m.threadId ?? null,
				inReplyTo: header(headers, "In-Reply-To").replace(/^<|>$/g, "").trim() || null,
				date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
			};
		}),
	);
	const drafts = settled
		.filter((r): r is PromiseFulfilledResult<DraftRow> => r.status === "fulfilled")
		.map((r) => r.value);
	const failed = settled.length - drafts.length;
	if (failed) console.log(`getDrafts: ${failed}/${settled.length} drafts failed to load`);
	return { drafts };
}

// ── Push notification summary ───────────────────────────────────────────────
// The service worker fetches this on a (payloadless) push to build the
// notification, and the room shows it as a header count.
export type Glance = { unread: number; from: string | null; subject: string | null };

export async function inboxGlance(env: Env): Promise<Glance> {
	const [labelRes, listRes] = await Promise.all([
		gmailGet(env, "/labels/INBOX") as Promise<{ messagesUnread?: number }>,
		gmailGet(env, "/messages?labelIds=INBOX&labelIds=UNREAD&maxResults=1") as Promise<{
			messages?: { id: string }[];
		}>,
	]);
	const unread = labelRes.messagesUnread ?? 0;
	const newestId = listRes.messages?.[0]?.id;
	if (!newestId) return { unread, from: null, subject: null };
	const row = await fetchRow(env, newestId);
	return { unread, from: row.from, subject: row.subject };
}

// ── Capture-to-Task: write a real row to EV25-Tasks ─────────────────────────
// Mapped to the live schema (audited 27 Jun): Task title, Assigned + Due both set
// to the same picked value (timed → both carry the time, all-day otherwise),
// Category select, High Priority checkbox, Status = Not started. EV25-Tasks has no
// URL property, so the Gmail deep-link + snippet go in the page body.
const NOTION_API = "https://api.notion.com/v1";
// The tasks data source id lives in workshop.mappings config now (Fuse Box
// Phase 6) — loaded at the create site.

export type TaskInput = {
	title: string;
	date: string; // YYYY-MM-DD (Perth), resolved client-side from the quick chips
	time: string | null; // HH:MM (Perth) or null for all-day
	category: string | null;
	highPriority: boolean;
	// The email context (Gmail deep-link + preview for the page body). Optional
	// since the brain's create_task tool reuses this write with no email in hand;
	// the Post Box path always sends all four.
	gmailUrl?: string;
	snippet?: string;
	subject?: string;
	from?: string;
};

// An action-oriented Task title suggested from the email — the micro-choice the
// brief left for Elle (raw subject vs. an AI action title). Its own small
// Anthropic call (NOT the brain), surfaced behind a button so it only runs when
// she asks. Falls back to the subject on any failure.
export async function suggestTaskTitle(
	env: Env,
	input: { subject: string; snippet: string; from: string },
): Promise<{ title: string }> {
	const anthropicKey = await getSecret(env, "ANTHROPIC_API_KEY");
	const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"x-api-key": anthropicKey,
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: "claude-haiku-4-5-20251001",
			max_tokens: 32,
			system:
				'Turn an email into a short, action-oriented to-do title for the task list. Reply with ONLY the title: an imperative phrase, at most ~8 words, no surrounding quotes, no trailing full stop. Examples — a flight confirmation → "Check in for PER→MEL flight"; a bank statement → "Review the Bankwest statement"; a dentist reminder → "Confirm the dental appointment".',
			messages: [
				{
					role: "user",
					content: `From: ${input.from}\nSubject: ${input.subject}\nPreview: ${input.snippet}`,
				},
			],
		}),
	}, { service: "anthropic" });
	if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
	const data = (await res.json()) as { content?: { type: string; text?: string }[] };
	const text = (data.content ?? [])
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("")
		.trim();
	const title = text.replace(/^["']|["']$/g, "").replace(/\.$/, "").trim();
	return { title: title || input.subject };
}

export async function createTask(env: Env, t: TaskInput): Promise<{ url: string }> {
	// Perth is UTC+8, no DST — a fixed offset is exact. A time → datetime (Notion
	// infers is_datetime from the presence of a clock time); no time → all-day.
	const start = t.time ? `${t.date}T${t.time}:00+08:00` : t.date;

	const properties: Record<string, unknown> = {
		Task: { title: [{ text: { content: t.title } }] },
		"Assigned Date": { date: { start } },
		"Due Date": { date: { start } },
		"High Priority": { checkbox: t.highPriority },
		Status: { status: { name: "Not started" } },
	};
	if (t.category) properties.Category = { select: { name: t.category } };

	// The page body carries the context EV25-Tasks can't hold in a property: a
	// link back to the email in Gmail, then its snippet. Only when there IS an
	// email — a brain-created task has no mail behind it, so its body stays empty.
	const children = t.gmailUrl
		? [
				{
					object: "block",
					type: "paragraph",
					paragraph: {
						rich_text: [
							{ type: "text", text: { content: `📬 ${t.from ?? ""} — ${t.subject ?? ""}\n` } },
							{ type: "text", text: { content: "Open email in Gmail", link: { url: t.gmailUrl } } },
						],
					},
				},
				{
					object: "block",
					type: "quote",
					quote: { rich_text: [{ type: "text", text: { content: t.snippet || "(no preview)" } }] },
				},
			]
		: undefined;

	const notionToken = await getSecret(env, "NOTION_TOKEN");
	const res = await fetchWithTimeout(`${NOTION_API}/pages`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${notionToken}`,
			"Notion-Version": env.NOTION_VERSION,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			parent: { type: "data_source_id", data_source_id: (await loadWorkshopMappings(env)).tasks_ds },
			properties,
			...(children ? { children } : {}),
		}),
	}, { service: "notion" });
	if (!res.ok) throw new Error(`Notion page create ${res.status}: ${await res.text()}`);
	const page = (await res.json()) as { url: string };
	return { url: page.url };
}
