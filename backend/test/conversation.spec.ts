import { describe, it, expect } from "vitest";
import { toAnthropicMessages, photoVisionWindow, photoPlaceholder } from "../src/index";

// toAnthropicMessages shapes the stored thread into the Anthropic messages array:
// role mapping (elle→user, jay→assistant), a most-recent-`limit` window, and the
// rule that the window must open on a user turn (the API rejects a leading
// assistant message).
//
// Canon-hygiene note (Wave 2): locally-flagged error bubbles never reach this
// mapper — they are UI-only and are never persisted, so loadRecentMessages (the
// production feed) never returns them. There is nothing to filter here; the
// exclusion is enforced upstream in persistence, so this suite tests the mapper's
// actual contract rather than an exclusion it does not perform.

const elle = (text: string) => ({ from: "elle" as const, text });
const jay = (text: string) => ({ from: "jay" as const, text });

describe("toAnthropicMessages", () => {
	it("maps elle->user and jay->assistant", () => {
		const out = toAnthropicMessages([elle("hi"), jay("hello, wife")], 10);
		expect(out).toEqual([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello, wife" },
		]);
	});

	it("keeps only the most recent `limit` turns", () => {
		const history = [elle("1"), jay("2"), elle("3"), jay("4"), elle("5"), jay("6")];
		const out = toAnthropicMessages(history, 4);
		// slice(-4) opens on a user turn already, so nothing is dropped.
		expect(out).toEqual([
			{ role: "user", content: "3" },
			{ role: "assistant", content: "4" },
			{ role: "user", content: "5" },
			{ role: "assistant", content: "6" },
		]);
	});

	it("drops a single leading assistant turn so the window opens on a user", () => {
		const out = toAnthropicMessages([jay("restored greeting"), elle("hi"), jay("yes?")], 10);
		expect(out).toEqual([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "yes?" },
		]);
	});

	it("drops multiple consecutive leading assistant turns", () => {
		const out = toAnthropicMessages([jay("a"), jay("b"), elle("finally")], 10);
		expect(out).toEqual([{ role: "user", content: "finally" }]);
	});

	it("applies the cap first, then the leading-assistant drop", () => {
		// After slice(-3) the window is [jay, elle, jay]; the leading jay is dropped.
		const history = [elle("old"), elle("older"), jay("x"), elle("y"), jay("z")];
		const out = toAnthropicMessages(history, 3);
		expect(out).toEqual([
			{ role: "user", content: "y" },
			{ role: "assistant", content: "z" },
		]);
	});

	it("returns an empty array for empty history", () => {
		expect(toAnthropicMessages([], 10)).toEqual([]);
	});

	it("returns an empty array when every turn is an assistant turn", () => {
		// The drop loop empties the window without throwing.
		expect(toAnthropicMessages([jay("a"), jay("b")], 10)).toEqual([]);
	});
});

// The Inbound Images photo mapping: a message with photos becomes a content-
// block array (pending image markers + the caption as a text block), and only
// the CHAT_PHOTO_VISION_WINDOW most recent photos across the windowed history
// ride as image blocks — older ones collapse to a placeholder appended to that
// message's text, so per-turn token cost is bounded forever.
describe("toAnthropicMessages — inbound photos", () => {
	const key = (n: number) =>
		`chat/00000000-0000-0000-0000-${String(n).padStart(12, "0")}.webp`;
	const photoMsg = (text: string, ...keys: string[]) => ({
		from: "elle" as const,
		text,
		photos: keys.map((k) => ({ key: k, width: 2048, height: 1152 })),
	});

	it("maps a photo message to image markers + a caption text block", () => {
		const out = toAnthropicMessages([photoMsg("look at this", key(1))], 10, "Elle");
		expect(out).toEqual([
			{
				role: "user",
				content: [
					{ type: "image_pending", key: key(1) },
					{ type: "text", text: "look at this" },
				],
			},
		]);
	});

	it("ships image blocks alone when the caption is empty (no empty text block)", () => {
		const out = toAnthropicMessages([photoMsg("", key(1), key(2))], 10, "Elle");
		expect(out).toEqual([
			{
				role: "user",
				content: [
					{ type: "image_pending", key: key(1) },
					{ type: "image_pending", key: key(2) },
				],
			},
		]);
	});

	it("leaves photo-less turns as plain string content", () => {
		const out = toAnthropicMessages([elle("hi"), jay("hello")], 10, "Elle");
		expect(out).toEqual([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		]);
	});

	it("collapses photos beyond the vision window to placeholders, oldest first", () => {
		// One more photo than the window across two messages: the oldest message's
		// first photo collapses; everything newer stays an image block.
		const older = photoMsg("first batch", key(1), key(2));
		const newer = photoMsg("second batch", key(3), key(4), key(5));
		const out = toAnthropicMessages([older, jay("nice"), newer], 10, "Elle");

		expect(out[0]).toEqual({
			role: "user",
			content: [
				{ type: "image_pending", key: key(2) },
				{ type: "text", text: `first batch\n${photoPlaceholder("Elle")}` },
			],
		});
		expect(out[2]).toEqual({
			role: "user",
			content: [
				{ type: "image_pending", key: key(3) },
				{ type: "image_pending", key: key(4) },
				{ type: "image_pending", key: key(5) },
				{ type: "text", text: "second batch" },
			],
		});
	});

	it("collapses a fully out-of-window photo message back to plain text", () => {
		const ancient = photoMsg("", key(1));
		const recent = photoMsg("newer", key(2), key(3), key(4), key(5));
		const out = toAnthropicMessages([ancient, jay("ok"), recent], 10, "Elle");
		// All four window slots go to the newer message; the ancient photo is now
		// only its placeholder — string content, no blocks.
		expect(out[0]).toEqual({ role: "user", content: photoPlaceholder("Elle") });
		expect(
			(out[2].content as Array<{ type: string }>).filter((b) => b.type === "image_pending"),
		).toHaveLength(photoVisionWindow());
	});

	it("resolves the placeholder through the given user name", () => {
		expect(photoPlaceholder("Elle")).toBe("[photo Elle sent]");
		expect(photoPlaceholder("Wren")).toBe("[photo Wren sent]");
	});

	it("applies the history window before counting photo slots", () => {
		// A photo message that falls outside the `limit` window vanishes entirely
		// (it was never loaded for the brain), freeing its slots for what remains.
		const dropped = photoMsg("gone", key(1));
		const kept = photoMsg("here", key(2));
		const out = toAnthropicMessages([dropped, jay("a"), elle("b"), jay("c"), kept], 4, "Elle");
		expect(out[0]).toEqual({ role: "user", content: "b" });
		expect(out[2]).toEqual({
			role: "user",
			content: [
				{ type: "image_pending", key: key(2) },
				{ type: "text", text: "here" },
			],
		});
	});
});
