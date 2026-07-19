/**
 * Vale OS — conversation persistence.
 *
 * Saving and restoring turns in Supabase. The caller decides *whether* to touch
 * the database (live only, gated on ENVIRONMENT); this module just does the work
 * when asked.
 *
 * The schema models a room as having a single active conversation at a time
 * (conversations.state = active | archived | ended), with messages hanging off
 * a conversation_id. These helpers follow that shape.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// A turn in the shape the front-end speaks: { id, from, text, created_at }.
// created_at is the existing messages.created_at (timestamptz) — surfaced so the
// feed can show day dividers and cluster times. Read-only: nothing new is
// written, this just stops dropping a column the select already orders by.
// `voice` surfaces metadata.voice (a voice note's audio attachment) so the feed
// can render the player; the text stays the transcript — the canon — and the
// brain's history mapping ({from, text}) never sees the attachment.
// `image` surfaces metadata.image (a generate_image row reference) the same
// way: the text stays the intent, the client resolves the id against the
// Gallery for the inline render.
export type VoiceAttachment = { key: string; chars?: number };
export type ImageAttachment = { id: string };
export type StoredMessage = {
	id: string;
	from: string;
	text: string;
	created_at: string;
	voice?: VoiceAttachment;
	image?: ImageAttachment;
};

// Pull a well-formed voice attachment out of a message's jsonb metadata, or
// undefined — a malformed blob degrades to a plain text message, never a crash.
function voiceFromMetadata(metadata: unknown): VoiceAttachment | undefined {
	const voice = (metadata as { voice?: { key?: unknown; chars?: unknown } } | null)?.voice;
	if (!voice || typeof voice.key !== "string" || !voice.key) return undefined;
	return {
		key: voice.key,
		...(typeof voice.chars === "number" ? { chars: voice.chars } : {}),
	};
}

// Same degrade-to-text discipline for an image reference.
function imageFromMetadata(metadata: unknown): ImageAttachment | undefined {
	const image = (metadata as { image?: { id?: unknown } } | null)?.image;
	if (!image || typeof image.id !== "string" || !image.id) return undefined;
	return { id: image.id };
}

/** Resolve a room name to its id. Throws if the room doesn't exist. */
async function getRoomId(
	supabase: SupabaseClient,
	roomName: string,
): Promise<string> {
	const { data, error } = await supabase
		.from("rooms")
		.select("id")
		.eq("name", roomName)
		.single();
	if (error) throw new Error(`room lookup failed: ${error.message}`);
	return data.id;
}

/** Find the room's active conversation, or null if it hasn't started one. */
async function findActiveConversationId(
	supabase: SupabaseClient,
	roomId: string,
): Promise<string | null> {
	const { data, error } = await supabase
		.from("conversations")
		.select("id")
		.eq("room_id", roomId)
		.eq("state", "active")
		.order("last_active_at", { ascending: false })
		.limit(1)
		.maybeSingle();
	if (error) throw new Error(`conversation lookup failed: ${error.message}`);
	return data?.id ?? null;
}

/**
 * Find the room's active conversation, or open a fresh one. Returns an id either
 * way, so the caller always has somewhere to write. Used on the write path.
 */
export async function getOrCreateActiveConversation(
	supabase: SupabaseClient,
	roomName: string,
): Promise<string> {
	const roomId = await getRoomId(supabase, roomName);
	const existing = await findActiveConversationId(supabase, roomId);
	if (existing) return existing;

	const { data, error } = await supabase
		.from("conversations")
		.insert({ room_id: roomId })
		.select("id")
		.single();
	if (error) {
		// Lost the create race with the other device — the partial unique index
		// (one active conversation per room) rejected this second insert. The
		// winner already exists, so re-select it rather than erroring.
		if ((error as { code?: string }).code === "23505") {
			const winner = await findActiveConversationId(supabase, roomId);
			if (winner) return winner;
		}
		throw new Error(`conversation create failed: ${error.message}`);
	}
	return data.id;
}

/**
 * Load the newest `limit` messages of a conversation, oldest-first (so the feed
 * renders in order). The query pulls the tail via a descending limit and flips
 * it — it never loads the whole thread, so the read path can't grow unbounded.
 * This is the primitive both the write path (recent window for the brain) and
 * the read path (history restore) share.
 */
export async function loadRecentMessages(
	supabase: SupabaseClient,
	conversationId: string,
	limit: number,
): Promise<StoredMessage[]> {
	const { data, error } = await supabase
		.from("messages")
		.select("id, role, content, created_at, metadata")
		.eq("conversation_id", conversationId)
		.order("created_at", { ascending: false })
		.limit(limit);
	if (error) throw new Error(`message load failed: ${error.message}`);

	return (data ?? [])
		.reverse()
		.map((m) => {
			const voice = voiceFromMetadata(m.metadata);
			const image = imageFromMetadata(m.metadata);
			return {
				id: m.id,
				from: m.role,
				text: m.content,
				created_at: m.created_at,
				...(voice ? { voice } : {}),
				...(image ? { image } : {}),
			};
		});
}

/**
 * Load a room's active conversation (newest `limit`, oldest-first), already
 * mapped to the front-end's shape. Returns [] if no conversation has started —
 * notably it does NOT open one, so a page load never creates an empty thread.
 */
export async function loadActiveConversationMessages(
	supabase: SupabaseClient,
	roomName: string,
	limit = 200,
): Promise<StoredMessage[]> {
	const roomId = await getRoomId(supabase, roomName);
	const conversationId = await findActiveConversationId(supabase, roomId);
	if (!conversationId) return [];
	return loadRecentMessages(supabase, conversationId, limit);
}

/**
 * Append one turn to a conversation. `metadata` is optional jsonb — used to
 * stash per-call token usage on Jay's turn (see the messages.metadata column),
 * so cost is attributable per exchange and accrues from real traffic.
 */
export async function saveMessage(
	supabase: SupabaseClient,
	conversationId: string,
	role: "elle" | "jay",
	content: string,
	metadata?: Record<string, unknown>,
): Promise<{ id: string; created_at: string }> {
	const row: Record<string, unknown> = {
		conversation_id: conversationId,
		role,
		content,
	};
	if (metadata) row.metadata = metadata;
	// Return the server-assigned id + created_at so the caller can hand the
	// client a canonical timestamp to reconcile its optimistic bubble against.
	const { data, error } = await supabase
		.from("messages")
		.insert(row)
		.select("id, created_at")
		.single();
	if (error) throw new Error(`message save failed: ${error.message}`);
	return { id: data.id, created_at: data.created_at };
}

/** Bump the conversation's activity clock so it stays the most recent active one. */
export async function touchConversation(
	supabase: SupabaseClient,
	conversationId: string,
): Promise<void> {
	await supabase
		.from("conversations")
		.update({ last_active_at: new Date().toISOString() })
		.eq("id", conversationId);
}

// ── Voice notes (the "Say this" path) ───────────────────────────────────────

/**
 * One message, loaded for the say-this render: its words, who said them, and
 * the raw metadata (so the update below can merge rather than clobber the cost
 * blob that already lives there on Jay's turns). Throws if the id doesn't
 * exist.
 */
export async function getMessageForVoice(
	supabase: SupabaseClient,
	messageId: string,
): Promise<{
	id: string;
	role: string;
	content: string;
	metadata: Record<string, unknown>;
	voice?: VoiceAttachment;
}> {
	const { data, error } = await supabase
		.from("messages")
		.select("id, role, content, metadata")
		.eq("id", messageId)
		.single();
	if (error) throw new Error(`message lookup failed: ${error.message}`);
	return {
		id: data.id,
		role: data.role,
		content: data.content,
		metadata: (data.metadata as Record<string, unknown>) ?? {},
		voice: voiceFromMetadata(data.metadata),
	};
}

/**
 * Attach a rendered voice note to an existing message. `merged` must be the
 * FULL metadata object (existing keys + the new voice blob) — this sets, it
 * doesn't patch, so callers merge against what getMessageForVoice returned.
 * The message text is deliberately untouched: for say-this the words already
 * on the row ARE the canon; the audio is only ever an attachment.
 */
export async function setMessageMetadata(
	supabase: SupabaseClient,
	messageId: string,
	merged: Record<string, unknown>,
): Promise<void> {
	const { error } = await supabase
		.from("messages")
		.update({ metadata: merged })
		.eq("id", messageId);
	if (error) throw new Error(`metadata update failed: ${error.message}`);
}


