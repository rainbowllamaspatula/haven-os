import { describe, it, expect } from "vitest";
import { toAnthropicMessages } from "../src/index";

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
