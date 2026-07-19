import { describe, it, expect } from "vitest";
import {
	COLOR_SLOTS,
	FONT_SLOTS,
	FONT_STACKS,
	normalizeHex,
	validateDecorTokens,
	sanitizeDecorTokens,
	resolveDecor,
	decorCss,
	injectDecor,
	parseDecorImport,
} from "../src/decor";

// A small honest theme: two colour slots, one font pick, everything else
// left to fall back to neutral — the sparse shape the engine must support.
const SPARSE = {
	colors: {
		bg: { dark: "#0F1717", light: "#FAFAF9" },
		teal: { dark: "#1B7B7E", light: "#1B7B7E" },
	},
	fonts: { disp: "fraunces" },
};

describe("normalizeHex", () => {
	it("passes 6-digit hex, uppercased", () => {
		expect(normalizeHex("#1b7b7e")).toBe("#1B7B7E");
	});
	it("expands 3-digit hex", () => {
		expect(normalizeHex("#fff")).toBe("#FFFFFF");
	});
	it("refuses everything else", () => {
		expect(normalizeHex("teal")).toBeNull();
		expect(normalizeHex("#12345")).toBeNull();
		expect(normalizeHex("rgb(1,2,3)")).toBeNull();
		expect(normalizeHex(12)).toBeNull();
	});
});

describe("validateDecorTokens — the write gate, loud and specific", () => {
	it("accepts a sparse theme", () => {
		const v = validateDecorTokens(SPARSE);
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.tokens.colors["bg"].dark).toBe("#0F1717");
	});

	it("accepts the empty theme (everything neutral)", () => {
		expect(validateDecorTokens({}).ok).toBe(true);
	});

	it("rejects a slot this house does not have, by name", () => {
		const v = validateDecorTokens({ colors: { "hot-pink": { dark: "#FF00FF", light: "#FF00FF" } } });
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.error).toContain("hot-pink");
	});

	it("rejects a non-hex colour, naming the slot", () => {
		const v = validateDecorTokens({ colors: { bg: { dark: "teal", light: "#FAFAF9" } } });
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.error).toContain("bg");
	});

	it("requires BOTH modes per colour slot", () => {
		const v = validateDecorTokens({ colors: { bg: { dark: "#0F1717" } } });
		expect(v.ok).toBe(false);
	});

	it("rejects a font off the curated list", () => {
		const v = validateDecorTokens({ fonts: { body: "comic-sans" } });
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.error).toContain("comic-sans");
	});
});

describe("sanitizeDecorTokens — the read gate never bricks the walls", () => {
	it("keeps the valid, drops the broken, throws never", () => {
		const t = sanitizeDecorTokens({
			colors: {
				bg: { dark: "#0F1717", light: "#FAFAF9" },
				teal: { dark: "not-a-colour", light: "#1B7B7E" }, // broken → dropped
				ghost: { dark: "#111111", light: "#222222" }, // unknown slot → dropped
			},
			fonts: { disp: "fraunces", mono: "papyrus" }, // papyrus → dropped
		});
		expect(Object.keys(t.colors)).toEqual(["bg"]);
		expect(t.fonts).toEqual({ disp: "fraunces" });
	});

	it("shrugs at garbage rows", () => {
		expect(sanitizeDecorTokens(null)).toEqual({ colors: {}, fonts: {} });
		expect(sanitizeDecorTokens("vandalism")).toEqual({ colors: {}, fonts: {} });
	});
});

describe("resolveDecor — neutral fills every gap", () => {
	it("resolves every slot, themed or not", () => {
		const r = resolveDecor(SPARSE);
		expect(r.colors["bg"].dark).toBe("#0F1717"); // themed
		const sage = COLOR_SLOTS.find((s) => s.key === "sage")!;
		expect(r.colors["sage"]).toEqual(sage.neutral); // fallback
		expect(r.fonts.disp).toBe("fraunces");
		expect(r.fonts.body).toBe(FONT_SLOTS.find((f) => f.key === "body")!.neutral);
	});

	it("null tokens = the full neutral default", () => {
		const r = resolveDecor(null);
		for (const slot of COLOR_SLOTS) expect(r.colors[slot.key]).toEqual(slot.neutral);
	});
});

describe("decorCss — what the shell actually wears", () => {
	it("emits dark values into :root (the worn mode) and light into its block", () => {
		const css = decorCss(SPARSE);
		const [rootBlock, lightBlock] = css.split("\n");
		expect(rootBlock).toContain("--bg: #0F1717;");
		expect(lightBlock).toContain('[data-decor-mode="light"]');
		expect(lightBlock).toContain("--bg: #FAFAF9;");
	});

	it("emits EVERY slot, so a theme switch fully overrides the compiled default", () => {
		const css = decorCss(SPARSE);
		for (const slot of COLOR_SLOTS) {
			expect(css).toContain(`--${slot.key}:`);
		}
		for (const f of FONT_SLOTS) {
			expect(css).toContain(`--${f.key}:`);
		}
	});

	it("emits the curated stack for a font pick", () => {
		expect(decorCss(SPARSE)).toContain(`--disp: ${FONT_STACKS["fraunces"]};`);
	});
});

describe("injectDecor — serve-time dressing", () => {
	const SHELL =
		'<head><meta name="theme-color" content="#141618" /></head>' +
		'<body><style id="decor"></style><div id="root"></div></body>';

	it("fills the placeholder and marks it data-live", () => {
		const out = injectDecor(SHELL, ":root { --bg: #0F1717; }", "#0F1717");
		expect(out).toContain('<style id="decor" data-live="1">:root { --bg: #0F1717; }</style>');
		expect(out).toContain('<meta name="theme-color" content="#0F1717" />');
	});

	it("no css → the shell passes through byte-identical", () => {
		expect(injectDecor(SHELL, null)).toBe(SHELL);
	});

	it("a shell without the placeholder is left alone", () => {
		const bare = "<body>login page</body>";
		expect(injectDecor(bare, ":root{}", "#000000")).toBe(bare);
	});
});

describe("parseDecorImport — the honest mapper", () => {
	it("maps a VDS-shaped file (:root light + [data-theme=dark]) onto both modes", () => {
		const report = parseDecorImport(`
			:root {
				--background: #FAFAF9;
				--text-primary: #161514;
				--primary-500: #1B7B7E;
				--font-display: 'Fraunces', Georgia, serif;
				--space-4: 16px;
			}
			[data-theme="dark"] {
				--background: #0F1717;
				--text-primary: #F4F3F1;
				--primary-500: #1B7B7E;
			}
		`);
		expect(report.modes).toBe("both");
		expect(report.colors["bg"]).toMatchObject({ dark: "#0F1717", light: "#FAFAF9" });
		expect(report.colors["tx"]).toMatchObject({ dark: "#F4F3F1", light: "#161514" });
		expect(report.colors["teal"]).toMatchObject({ dark: "#1B7B7E", light: "#1B7B7E" });
		expect(report.fonts["disp"]).toMatchObject({ pick: "fraunces" });
		// Spacing is not a colour — listed honestly, never guessed at.
		expect(report.unmapped).toContain("--space-4");
		// Unfilled slots are named so the neutral fallback is visible, not silent.
		expect(report.unfilled).toContain("sage");
	});

	it("a single-block paste fills BOTH modes (the dark-only house's shape)", () => {
		const report = parseDecorImport(":root { --bg: #101314; }");
		expect(report.modes).toBe("single");
		expect(report.colors["bg"]).toMatchObject({ dark: "#101314", light: "#101314" });
	});

	it("app-native slot names map directly", () => {
		const report = parseDecorImport(":root { --surface-2: #243232; --teal-300: #73B6B8; }");
		expect(report.colors["surface-2"].dark).toBe("#243232");
		expect(report.colors["teal-300"].dark).toBe("#73B6B8");
	});

	it("recognised name with an unusable value (var chain) goes to unmapped", () => {
		const report = parseDecorImport(":root { --background: var(--neutral-50); }");
		expect(report.colors["bg"]).toBeUndefined();
		expect(report.unmapped).toContain("--background");
	});

	it("an unknown font family is unmapped, never guessed", () => {
		const report = parseDecorImport(":root { --font-body: 'Papyrus', fantasy; }");
		expect(report.fonts["body"]).toBeUndefined();
		expect(report.unmapped).toContain("--font-body");
	});

	it("Atkinson Hyperlegible — Haven's body face — maps by family name", () => {
		const report = parseDecorImport(
			":root { --font-body: 'Atkinson Hyperlegible', system-ui, sans-serif; }",
		);
		expect(report.fonts["body"]).toMatchObject({ pick: "atkinson-hyperlegible" });
	});
});
