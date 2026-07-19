import { describe, it, expect } from "vitest";
import {
	deriveTranscript,
	capAtParagraphSeam,
	audioKey,
	verbatimFidelityBreach,
	SCRIPT_MAX_CHARS,
} from "../src/voice";

// The transcript is derived MECHANICALLY from the tagged script — these tests
// pin the skill's transcript rules: no tags visible, CAPS-emphasis → *italics*,
// paragraphed, whitespace tidy, written sounds kept (they were performed).
describe("deriveTranscript", () => {
	it("strips a single audio tag", () => {
		expect(deriveTranscript("[softly] Come here.")).toBe("Come here.");
	});

	it("strips stacked tags and mid-sentence tags", () => {
		expect(
			deriveTranscript("[teasing] [low] You really thought [warm chuckle] I wouldn't notice..."),
		).toBe("You really thought I wouldn't notice...");
	});

	it("keeps written sounds - they were performed", () => {
		expect(deriveTranscript("[laughs] haha you actually did it.")).toBe(
			"haha you actually did it.",
		);
	});

	it("renders a CAPS word as italics, lowered", () => {
		expect(deriveTranscript("It was a VERY long day.")).toBe("It was a *very* long day.");
	});

	it("italicises a multi-word CAPS run as one span", () => {
		expect(deriveTranscript("That was SO GOOD, wife.")).toBe("That was *so good*, wife.");
	});

	it("handles apostrophes inside a CAPS word", () => {
		expect(deriveTranscript("DON'T move.")).toBe("*don't* move.");
	});

	it("never touches a single capital (I, or a sentence opener)", () => {
		expect(deriveTranscript("I know. A quiet day.")).toBe("I know. A quiet day.");
	});

	it("tidies the whitespace tag-stripping leaves behind", () => {
		// A stripped tag can orphan a space before punctuation or double one
		// mid-sentence — neither survives into the transcript.
		expect(deriveTranscript("Wait [sighs] , alright...")).toBe("Wait, alright...");
		expect(deriveTranscript("So [pause] there it is.")).toBe("So there it is.");
	});

	it("keeps paragraphs but collapses blank-heavy gaps", () => {
		expect(deriveTranscript("[warm] First thought.\n\n\n\n[low] Second thought...")).toBe(
			"First thought.\n\nSecond thought...",
		);
	});

	it("keeps the trailing ellipsis (the no-clip rule is punctuation, not a tag)", () => {
		expect(deriveTranscript("[softly] Goodnight, Blue...")).toBe("Goodnight, Blue...");
	});
});

// The 3,000-char backstop under the render prompt's own target: prefer a
// paragraph seam, then a sentence end, then whitespace — never mid-word, and
// the capped script always still ends in "..." and never exceeds the ceiling.
describe("capAtParagraphSeam", () => {
	it("returns a script under the ceiling untouched", () => {
		const s = "Short and sweet...";
		expect(capAtParagraphSeam(s)).toBe(s);
	});

	it("cuts at the last paragraph seam before the ceiling", () => {
		const para = "A paragraph that ends properly.";
		const script = `${para}\n\n${para}\n\n${"x".repeat(80)}`;
		const capped = capAtParagraphSeam(script, 80);
		expect(capped).toBe(`${para}\n\n${para}...`);
		expect(capped.length).toBeLessThanOrEqual(80);
	});

	it("falls back to a sentence end when there is no paragraph seam", () => {
		const script = `One sentence here. Another one there. ${"y".repeat(60)}`;
		const capped = capAtParagraphSeam(script, 60);
		expect(capped).toBe("One sentence here. Another one there....");
		expect(capped.length).toBeLessThanOrEqual(60);
	});

	it("falls back to whitespace - never cuts a word in half", () => {
		const script = "wordone wordtwo wordthree wordfour wordfive";
		const capped = capAtParagraphSeam(script, 30);
		// Every kept chunk is a whole input word (minus the appended ellipsis).
		const kept = capped.replace(/\.\.\.$/, "");
		for (const w of kept.split(/\s+/)) {
			expect(script.split(/\s+/)).toContain(w);
		}
		expect(capped.length).toBeLessThanOrEqual(30);
	});

	it("survives one giant unbroken token (last resort still under the ceiling)", () => {
		const capped = capAtParagraphSeam("z".repeat(5000), 100);
		expect(capped.length).toBeLessThanOrEqual(100);
		expect(capped.endsWith("...")).toBe(true);
	});

	it("never exceeds the real API ceiling with the default max", () => {
		const para = `${"real words in a sentence. ".repeat(20)}\n\n`;
		const capped = capAtParagraphSeam(para.repeat(30));
		expect(capped.length).toBeLessThanOrEqual(SCRIPT_MAX_CHARS);
		expect(capped.endsWith("...")).toBe(true);
	});

	it("does not double an ellipsis the cut already ends on", () => {
		const script = `A trailing thought...\n\n${"x".repeat(50)}`;
		const capped = capAtParagraphSeam(script, 50);
		expect(capped).toBe("A trailing thought...");
	});
});

describe("audioKey", () => {
	it("namespaces the R2 key under voice-notes/", () => {
		expect(audioKey("abc-123")).toBe("voice-notes/abc-123.mp3");
	});
});

// The say-this canon guard: an existing message's words are final, so a
// verbatim render that balloons (or guts) them is a breach. Pinned to the
// first live acceptance failure: five words in, a minute of ramble out.
describe("verbatimFidelityBreach", () => {
	it("passes a faithful render with tags' sounds and fillers", () => {
		const input = "Goodnight, Blue. Sleep well.";
		const transcript = "mmm... Goodnight, Blue. haha... Sleep *well*...";
		expect(verbatimFidelityBreach(input, transcript)).toBeNull();
	});

	it("rejects the five-words-in, minute-of-ramble-out case", () => {
		const input = "Goodnight, Blue. Sleep well.";
		const ramble =
			"Hey. Come here a second, wife. mmm... I want you to actually hear this one, " +
			"because you did so well today even when it did not feel like it, and I am " +
			"endlessly proud of you. Goodnight, Blue. Sleep well. I love you more than " +
			"I can fit in one little note, so let me just say it plainly and then say " +
			"it again tomorrow, and the day after that too...";
		expect(verbatimFidelityBreach(input, ramble)).toMatch(/added too much/);
	});

	it("rejects a render that dropped most of the message", () => {
		const input =
			"There are quite a few words in this particular message and they all matter to her.";
		expect(verbatimFidelityBreach(input, "Words matter...")).toMatch(/rewrote the message/);
	});

	it("rejects the live rewrite case: five words swapped for five others", () => {
		// 16 Jul acceptance, second failure: volume identical, substance replaced —
		// sailed through the ratio check and the prompt's own OVERRIDING RULE.
		expect(
			verbatimFidelityBreach("I'm ready. Let's hear it. 🖤", "whenever you're ready, love..."),
		).toMatch(/rewrote the message .*i'm/);
	});

	it("rejects a normalised contraction - an honest retry beats a liberty", () => {
		expect(verbatimFidelityBreach("I'm ready.", "I am ready...")).toMatch(/lost "i'm"/);
	});

	it("rejects reordered words - verbatim means in order", () => {
		expect(verbatimFidelityBreach("tea then bed", "bed then tea...")).toMatch(
			/rewrote the message/,
		);
	});

	it("ignores emoji on either side", () => {
		expect(verbatimFidelityBreach("Goodnight 🖤", "[softly] Goodnight...")).toBeNull();
	});

	it("gives short inputs breathing room for sounds without opening the ramble door", () => {
		// 5 words in → ceiling is 5*2+6 = 16 words out.
		const input = "one two three four five";
		const okay = "mmm one two three four five haha oh yes...";
		expect(verbatimFidelityBreach(input, okay)).toBeNull();
		const over = Array(20).fill("word").join(" ");
		expect(verbatimFidelityBreach(input, over)).toMatch(/added too much/);
	});

	it("counts real words, not tags' leavings or punctuation", () => {
		// Ellipses, dashes and asterisks never count toward the ratio.
		expect(verbatimFidelityBreach("hello there", "*hello* — there...")).toBeNull();
	});
});
