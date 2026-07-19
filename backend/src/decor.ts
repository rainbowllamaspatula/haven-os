/**
 * The Décor circuit — the theme engine (19 Jul 2026 brief).
 *
 * The design system is CANON, and canon lives in the database: the repo
 * compiles in a deliberately neutral default (a primed wall, nobody's
 * colours), and the house's actual aesthetic is a decor_theme_versions row
 * — token map in, CSS custom properties out, injected into the shell at
 * serve time and re-applied live by the client. No VDS value survives in
 * app code; the VDS theme is data entered through the Fuse Box.
 *
 * House rules, same as every config read since the cutover:
 *  - Per-request, never cached in module scope — a panel edit is live on
 *    the next call.
 *  - A bad paste must never brick the walls: reads SANITIZE (drop invalid
 *    entries, fall back to neutral per slot); writes VALIDATE LOUDLY
 *    (reject the save, name the slot). Zero themes is a legal state, not
 *    an error — that is the virgin-install / Haven-day-one look.
 *
 * Both modes ship per theme. The app wears the DARK values today (it has
 * been dark-only since the 30 May mockup — the light block is emitted
 * under [data-decor-mode="light"], which nothing sets yet; the day the
 * house grows a light switch, the data is already there).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ── The curated font list ────────────────────────────────────────────────────
// Bundled families only (the shell is offline-first and CDN-free — main.tsx
// imports @fontsource woff2s; a Google Fonts link would punch a hole in the
// no-network shell). The brief's minimum set: VDS's three + Haven's body face.
export const FONT_STACKS: Record<string, string> = {
	fraunces: "'Fraunces', Georgia, serif",
	inter: "'Inter', system-ui, sans-serif",
	"jetbrains-mono": "'JetBrains Mono', monospace",
	"atkinson-hyperlegible": "'Atkinson Hyperlegible', system-ui, sans-serif",
	// The system trio — the neutral default's "standard system-adjacent type
	// until themed", and an honest pick for a themeless install.
	"system-sans": "system-ui, -apple-system, sans-serif",
	"system-serif": "Georgia, 'Times New Roman', serif",
	"system-mono": "ui-monospace, Consolas, monospace",
};
export const FONT_KEYS = Object.keys(FONT_STACKS);

export type FontSlotKey = "disp" | "body" | "mono";
export const FONT_SLOTS: Array<{ key: FontSlotKey; label: string; neutral: string }> = [
	{ key: "disp", label: "Display", neutral: "system-serif" },
	{ key: "body", label: "Body", neutral: "system-sans" },
	{ key: "mono", label: "Mono", neutral: "system-mono" },
];

// ── The colour slot registry ─────────────────────────────────────────────────
// Slot keys ARE the CSS custom property names the rooms already resolve
// through — the refactor keeps every var() in place. The names read
// VDS-flavoured ("teal", "bronze") because they shipped as stable accent
// IDENTIFIERS in prod data (workshop.blocks accents, 18 Jul) — a slot named
// teal may hold any colour, exactly as a Workshop accent named teal already
// can. Renaming them would break live rows; the label column is for humans.
//
// The neutral values are the compiled-in default: warm greys, near-black
// warm ink, one restrained slate-teal accent that reads as nobody's.
// Pleasant, legible, deliberately unmemorable — a primed wall.
export type ColorSlot = {
	key: string;
	label: string;
	group: "Surfaces" | "Text" | "Accents" | "Accent derivatives" | "Gradients";
	neutral: { dark: string; light: string };
};

export const COLOR_SLOTS: ColorSlot[] = [
	// Surfaces
	{ key: "bg", label: "App background", group: "Surfaces", neutral: { dark: "#141618", light: "#FAFAF9" } },
	{ key: "surface", label: "Chrome / header", group: "Surfaces", neutral: { dark: "#1D2022", light: "#FFFFFF" } },
	{ key: "surface-2", label: "Raised cards", group: "Surfaces", neutral: { dark: "#272B2D", light: "#F0EFED" } },
	// Slot KEYS are stable identifiers in live theme rows (the teal ruling);
	// labels resolve {companion} from Identity at the panel route.
	{ key: "jay", label: "{companion}'s bubble", group: "Surfaces", neutral: { dark: "#232728", light: "#EEEFEE" } },
	{ key: "jay-border", label: "{companion}'s bubble border", group: "Surfaces", neutral: { dark: "#313638", light: "#DDDEDC" } },
	{ key: "bd", label: "Borders", group: "Surfaces", neutral: { dark: "#3C4144", light: "#CDCCC8" } },
	// Text
	{ key: "tx", label: "Text — primary", group: "Text", neutral: { dark: "#F2F1F0", light: "#1B1A19" } },
	{ key: "tx2", label: "Text — secondary", group: "Text", neutral: { dark: "#C8C7C4", light: "#45443F" } },
	{ key: "tx3", label: "Text — muted", group: "Text", neutral: { dark: "#9F9D99", light: "#7C7972" } },
	// Accents
	{ key: "teal", label: "Primary accent", group: "Accents", neutral: { dark: "#52797C", light: "#4A6F72" } },
	{ key: "teal-300", label: "Primary accent — light", group: "Accents", neutral: { dark: "#8FB0B2", light: "#52797C" } },
	{ key: "bronze", label: "Warm accent", group: "Accents", neutral: { dark: "#9C9082", light: "#8A7E6F" } },
	{ key: "bronze-100", label: "Warm accent — pale", group: "Accents", neutral: { dark: "#D8D0C4", light: "#57503F" } },
	{ key: "sage", label: "Soft accent", group: "Accents", neutral: { dark: "#97A39C", light: "#6E7B74" } },
	{ key: "red", label: "Alarm", group: "Accents", neutral: { dark: "#B05252", light: "#A34444" } },
	{ key: "amber", label: "Warning", group: "Accents", neutral: { dark: "#C99A56", light: "#A87830" } },
	// Accent derivatives — the literals the Step 0 probe surfaced, promoted to
	// slots so they follow the theme instead of staying welded VDS ink.
	{ key: "teal-100", label: "Primary tint (avatar text)", group: "Accent derivatives", neutral: { dark: "#C9D8D9", light: "#DCE6E6" } },
	{ key: "teal-hover", label: "Primary hover", group: "Accent derivatives", neutral: { dark: "#618E91", light: "#3E6163" } },
	{ key: "teal-ink", label: "Ink on primary", group: "Accent derivatives", neutral: { dark: "#0F1B1C", light: "#FFFFFF" } },
	{ key: "bronze-ink", label: "Ink on warm accent", group: "Accent derivatives", neutral: { dark: "#1B1712", light: "#FFFFFF" } },
	{ key: "pure", label: "Pure (knobs, play glyph)", group: "Accent derivatives", neutral: { dark: "#FFFFFF", light: "#FFFFFF" } },
	// Gradients — the Listening Room's six playlist placeholders (a/b stops).
	// Hand-tuned pairs in VDS (not a uniform darken), so they are honest slots,
	// not derivations the engine could fake without failing the golden test.
	{ key: "grad1a", label: "Gradient 1 — start", group: "Gradients", neutral: { dark: "#B05252", light: "#B05252" } },
	{ key: "grad1b", label: "Gradient 1 — end", group: "Gradients", neutral: { dark: "#6E3333", light: "#6E3333" } },
	{ key: "grad2a", label: "Gradient 2 — start", group: "Gradients", neutral: { dark: "#52797C", light: "#52797C" } },
	{ key: "grad2b", label: "Gradient 2 — end", group: "Gradients", neutral: { dark: "#32494B", light: "#32494B" } },
	{ key: "grad3a", label: "Gradient 3 — start", group: "Gradients", neutral: { dark: "#9C9082", light: "#9C9082" } },
	{ key: "grad3b", label: "Gradient 3 — end", group: "Gradients", neutral: { dark: "#5A5349", light: "#5A5349" } },
	{ key: "grad4a", label: "Gradient 4 — start", group: "Gradients", neutral: { dark: "#97A39C", light: "#97A39C" } },
	{ key: "grad4b", label: "Gradient 4 — end", group: "Gradients", neutral: { dark: "#4E5854", light: "#4E5854" } },
	{ key: "grad5a", label: "Gradient 5 — start", group: "Gradients", neutral: { dark: "#C99A56", light: "#C99A56" } },
	{ key: "grad5b", label: "Gradient 5 — end", group: "Gradients", neutral: { dark: "#6E5530", light: "#6E5530" } },
	{ key: "grad6a", label: "Gradient 6 — start", group: "Gradients", neutral: { dark: "#5B6F8A", light: "#5B6F8A" } },
	{ key: "grad6b", label: "Gradient 6 — end", group: "Gradients", neutral: { dark: "#2C3949", light: "#2C3949" } },
];

const COLOR_SLOT_KEYS = new Set(COLOR_SLOTS.map((s) => s.key));

// ── Token shapes ─────────────────────────────────────────────────────────────
export type ColorPair = { dark: string; light: string };
export type DecorTokens = {
	colors: Record<string, ColorPair>;
	fonts: Partial<Record<FontSlotKey, string>>;
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const SHORT_HEX = /^#[0-9a-fA-F]{3}$/;

/** Normalize a candidate hex: 6-digit passes, 3-digit expands, else null. */
export function normalizeHex(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const v = raw.trim();
	if (HEX.test(v)) return v.toUpperCase();
	if (SHORT_HEX.test(v)) {
		return ("#" + [...v.slice(1)].map((c) => c + c).join("")).toUpperCase();
	}
	return null;
}

/**
 * Validate a candidate token map for WRITING. Loud and specific: an unknown
 * slot, a non-hex colour, or a font outside the curated list rejects the
 * whole save (import never partially applies — confirm, then commit). Every
 * slot is optional; a missing slot resolves to neutral at read time.
 */
export function validateDecorTokens(
	value: unknown,
): { ok: true; tokens: DecorTokens } | { ok: false; error: string } {
	const v = value as Partial<DecorTokens> | null;
	if (!v || typeof v !== "object" || Array.isArray(v)) {
		return { ok: false, error: "tokens must be an object" };
	}
	const colors: Record<string, ColorPair> = {};
	if (v.colors !== undefined) {
		if (!v.colors || typeof v.colors !== "object" || Array.isArray(v.colors)) {
			return { ok: false, error: "tokens.colors must be an object" };
		}
		for (const [key, pair] of Object.entries(v.colors)) {
			if (!COLOR_SLOT_KEYS.has(key)) {
				return { ok: false, error: `"${key}" is not a colour slot this house has` };
			}
			const p = pair as Partial<ColorPair> | null;
			const dark = normalizeHex(p?.dark);
			const light = normalizeHex(p?.light);
			if (!dark || !light) {
				return {
					ok: false,
					error: `slot "${key}" needs dark and light as 6-digit hex colours`,
				};
			}
			colors[key] = { dark, light };
		}
	}
	const fonts: DecorTokens["fonts"] = {};
	if (v.fonts !== undefined) {
		if (!v.fonts || typeof v.fonts !== "object" || Array.isArray(v.fonts)) {
			return { ok: false, error: "tokens.fonts must be an object" };
		}
		for (const [slot, pick] of Object.entries(v.fonts)) {
			if (!FONT_SLOTS.some((f) => f.key === slot)) {
				return { ok: false, error: `"${slot}" is not a font slot (disp, body, mono)` };
			}
			if (typeof pick !== "string" || !FONT_KEYS.includes(pick)) {
				return {
					ok: false,
					error: `font "${String(pick)}" is not on the curated list (${FONT_KEYS.join(", ")})`,
				};
			}
			fonts[slot as FontSlotKey] = pick;
		}
	}
	return { ok: true, tokens: { colors, fonts } };
}

/**
 * Sanitize stored tokens for READING: keep what validates, drop what
 * doesn't. The read path never throws over a bad row — a broken slot wears
 * neutral, the app stays dressed. (Writes go through validateDecorTokens,
 * so this only earns its keep against rows edited outside the panel.)
 */
export function sanitizeDecorTokens(value: unknown): DecorTokens {
	const out: DecorTokens = { colors: {}, fonts: {} };
	const v = value as Partial<DecorTokens> | null;
	if (!v || typeof v !== "object") return out;
	if (v.colors && typeof v.colors === "object") {
		for (const [key, pair] of Object.entries(v.colors)) {
			if (!COLOR_SLOT_KEYS.has(key)) continue;
			const dark = normalizeHex((pair as Partial<ColorPair>)?.dark);
			const light = normalizeHex((pair as Partial<ColorPair>)?.light);
			if (dark && light) out.colors[key] = { dark, light };
		}
	}
	if (v.fonts && typeof v.fonts === "object") {
		for (const f of FONT_SLOTS) {
			const pick = (v.fonts as Record<string, unknown>)[f.key];
			if (typeof pick === "string" && FONT_KEYS.includes(pick)) out.fonts[f.key] = pick;
		}
	}
	return out;
}

/** Resolve a (possibly partial) token map to a full one — neutral fills the gaps. */
export function resolveDecor(tokens: DecorTokens | null): {
	colors: Record<string, ColorPair>;
	fonts: Record<FontSlotKey, string>;
} {
	const colors: Record<string, ColorPair> = {};
	for (const slot of COLOR_SLOTS) {
		colors[slot.key] = tokens?.colors[slot.key] ?? slot.neutral;
	}
	const fonts = {} as Record<FontSlotKey, string>;
	for (const f of FONT_SLOTS) {
		fonts[f.key] = tokens?.fonts[f.key] ?? f.neutral;
	}
	return { colors, fonts };
}

/**
 * Emit the CSS the shell wears. Dark values into :root — the app is
 * dark-only today, so :root IS the worn mode — plus the light block under
 * [data-decor-mode="light"], carried for the future switch. Values are
 * validated hex / curated stacks, so the emission is structurally safe to
 * inline in HTML (no user text ever reaches this string).
 */
export function decorCss(tokens: DecorTokens | null): string {
	const { colors, fonts } = resolveDecor(tokens);
	const dark = COLOR_SLOTS.map((s) => `--${s.key}: ${colors[s.key].dark};`).join(" ");
	const light = COLOR_SLOTS.map((s) => `--${s.key}: ${colors[s.key].light};`).join(" ");
	const type = FONT_SLOTS.map((f) => `--${f.key}: ${FONT_STACKS[fonts[f.key]]};`).join(" ");
	return `:root { ${dark} ${type} }\n[data-decor-mode="light"] { ${light} }`;
}

// ── The active theme, per request ────────────────────────────────────────────

function db(env: Env): SupabaseClient {
	return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
		auth: { persistSession: false, autoRefreshToken: false },
	});
}

export type ActiveDecor = { id: string; name: string; tokens: DecorTokens } | null;

/** The version the house currently wears, or null (neutral default). */
export async function loadActiveDecor(env: Env): Promise<ActiveDecor> {
	const { data, error } = await db(env)
		.from("decor_theme_versions")
		.select("id, name, tokens")
		.eq("is_active", true)
		.maybeSingle();
	if (error) throw new Error(`decor load failed: ${error.message}`);
	if (!data) return null;
	return { id: data.id, name: data.name, tokens: sanitizeDecorTokens(data.tokens) };
}

/**
 * Inject the active theme into the served shell. index.html carries an
 * empty <style id="decor"></style>; the Worker fills it at serve time so a
 * themed install paints right on the very first frame — no flash. data-live
 * marks a server fill; the boot script prefers its own last-good copy
 * (localStorage is newer than a stale precached shell) and seeds from this
 * when it has none.
 */
export function injectDecor(html: string, css: string | null, themeColor?: string): string {
	if (!css) return html;
	let out = html.replace(
		'<style id="decor"></style>',
		`<style id="decor" data-live="1">${css}</style>`,
	);
	// The PWA status bar should match the themed background from the first
	// frame too. themeColor is a validated hex (resolveDecor output), so the
	// replacement is structurally safe.
	if (themeColor) {
		out = out.replace(
			/<meta name="theme-color" content="#[0-9a-fA-F]{3,8}" \/>/,
			`<meta name="theme-color" content="${themeColor}" />`,
		);
	}
	return out;
}

// ── Import — paste a :root-style token file ──────────────────────────────────
// Both VDS and the Asher & Fia design file are already this shape. The
// parser maps recognised custom properties onto slots and reports the rest
// honestly; it never saves anything itself — the client shows the mapping,
// Elle confirms, and the confirmed tokens go through the normal save route
// (import never partially applies).

// Source-name aliases → slot keys. Direct slot names always work; these
// cover the VDS drop-in block's vocabulary (and Haven files built on it).
const IMPORT_ALIASES: Record<string, string> = {
	background: "bg",
	"surface-variant": "surface-2",
	border: "bd",
	"text-primary": "tx",
	"text-secondary": "tx2",
	"text-tertiary": "tx3",
	"primary-500": "teal",
	"primary-300": "teal-300",
	"primary-100": "teal-100",
	"secondary-300": "bronze",
	"secondary-100": "bronze-100",
	"tertiary-300": "sage",
	"error-500": "red",
	"warning-500": "amber",
	"font-display": "disp",
	"font-body": "body",
	"font-mono": "mono",
};

function slotForSource(name: string): string | null {
	const key = name.toLowerCase();
	if (COLOR_SLOT_KEYS.has(key) || FONT_SLOTS.some((f) => f.key === key)) return key;
	return IMPORT_ALIASES[key] ?? null;
}

/** Match a pasted font-family value to a curated key by its first family. */
function fontKeyForStack(value: string): string | null {
	const first = value.split(",")[0]?.trim().replace(/^['"]|['"]$/g, "").toLowerCase() ?? "";
	for (const [key, stack] of Object.entries(FONT_STACKS)) {
		const stackFirst = stack.split(",")[0].trim().replace(/^['"]|['"]$/g, "").toLowerCase();
		if (first === stackFirst) return key;
	}
	return null;
}

export type ImportReport = {
	/** slot → mapped pair (and which source var each mode came from). */
	colors: Record<string, { dark: string; light: string; source: string }>;
	fonts: Partial<Record<FontSlotKey, { pick: string; source: string }>>;
	/** Source custom properties we recognised nothing for — listed honestly. */
	unmapped: string[];
	/** Slots the paste didn't fill — these will wear the neutral default. */
	unfilled: string[];
	/** Whether the paste carried distinct light/dark blocks or one for both. */
	modes: "both" | "single";
};

/**
 * Parse a :root-style token file. Blocks whose selector mentions "dark" fill
 * the dark mode; other blocks fill light. A file with only one kind of
 * block fills BOTH modes (a dark-only house pastes a dark-only file).
 */
export function parseDecorImport(text: string): ImportReport {
	const decl = /--([a-zA-Z0-9-]+)\s*:\s*([^;{}]+);/g;
	const blocks: Array<{ dark: boolean; body: string }> = [];
	const blockRe = /([^{}]+)\{([^{}]*)\}/g;
	let m: RegExpExecArray | null;
	while ((m = blockRe.exec(text)) !== null) {
		blocks.push({ dark: /dark/i.test(m[1]), body: m[2] });
	}
	// A bare list of declarations with no selector at all: treat as one block.
	if (blocks.length === 0) blocks.push({ dark: false, body: text });

	const hasDark = blocks.some((b) => b.dark);
	const hasLight = blocks.some((b) => !b.dark);
	const modes: ImportReport["modes"] = hasDark && hasLight ? "both" : "single";

	const perMode: Record<"dark" | "light", Record<string, { value: string; source: string }>> = {
		dark: {},
		light: {},
	};
	const unmapped = new Set<string>();
	const fontPicks: ImportReport["fonts"] = {};

	for (const block of blocks) {
		const mode = block.dark ? "dark" : "light";
		let d: RegExpExecArray | null;
		decl.lastIndex = 0;
		while ((d = decl.exec(block.body)) !== null) {
			const source = d[1];
			const value = d[2].trim();
			const slot = slotForSource(source);
			if (!slot) {
				unmapped.add(`--${source}`);
				continue;
			}
			if (FONT_SLOTS.some((f) => f.key === slot)) {
				const pick = fontKeyForStack(value);
				if (pick) fontPicks[slot as FontSlotKey] = { pick, source: `--${source}` };
				else unmapped.add(`--${source}`);
				continue;
			}
			const hex = normalizeHex(value);
			if (!hex) {
				// Recognised name, unusable value (a var() chain, an rgb()) — honest.
				unmapped.add(`--${source}`);
				continue;
			}
			perMode[mode][slot] = { value: hex, source: `--${source}` };
		}
	}

	const colors: ImportReport["colors"] = {};
	for (const slot of COLOR_SLOTS) {
		const dark = perMode.dark[slot.key] ?? (modes === "single" ? perMode.light[slot.key] : undefined);
		const light = perMode.light[slot.key] ?? (modes === "single" ? perMode.dark[slot.key] : undefined);
		if (dark || light) {
			// One mode present fills both — a half-filled slot never half-applies.
			const d = (dark ?? light)!;
			const l = (light ?? dark)!;
			colors[slot.key] = { dark: d.value, light: l.value, source: d.source };
		}
	}
	const unfilled = COLOR_SLOTS.map((s) => s.key).filter((k) => !colors[k]);

	return { colors, fonts: fontPicks, unmapped: [...unmapped].sort(), unfilled, modes };
}
