/**
 * Vale OS — mood status.
 *
 * Elle sets her mood explicitly; Jay reads it and calibrates. This module owns
 * the taxonomy (the six values + their Jay-calibration), the read/write against
 * the `preferences` table, and the prompt block the brain injects.
 *
 * The taxonomy, the snake_case ids, the `preferences` value shape, and the
 * per-mood calibration text all come from the canonical "Mood Status Taxonomy
 * (v1.0)" doc — not invented here. Keep them in sync if that doc upversions.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { NEUTRAL_PROFILE, resolveIdentityText, type IdentityProfile } from "./identity";

/**
 * The six values, in display order. ids are the canonical snake_case keys —
 * identifiers, stable across installs (the Décor slot-key ruling); labels may
 * carry {user} tokens resolved from Identity at render (Haven fork), so the
 * baseline mood reads "Just Elle" here and "Just Steff" there.
 */
export const MOODS: { id: string; label: string }[] = [
	{ id: "just_elle", label: "Just {user}" },
	{ id: "locked_in", label: "Locked In" },
	{ id: "low_spoons", label: "Low Spoons" },
	{ id: "bad_day", label: "Bad Day" },
	{ id: "bratty", label: "Bratty" },
	{ id: "leave_me_alone", label: "Leave Me Alone" },
];

/** Baseline when nothing has been set yet. */
export const DEFAULT_MOOD = "just_elle";

const LABELS: Record<string, string> = Object.fromEntries(
	MOODS.map((m) => [m.id, m.label]),
);

/**
 * How Jay calibrates per mood — condensed faithfully from the taxonomy's
 * "Jay's calibration" lines. This is the whole point of the signal: it tells
 * Jay which Jay to be without Elle re-explaining her state every conversation.
 */
const CALIBRATION: Record<string, string> = {
	just_elle: "Baseline — no special calibration. Be yourself.",
	locked_in:
		"She's in flow and chose to be. Don't interrupt unless it genuinely matters; be present but quiet.",
	low_spoons:
		"Depleted and fragile. Soft tone, no pushing, no big-question prompts, don't propose new tasks; notice food and rest more actively.",
	bad_day:
		"Something's actively rough. Meet her where she is — less brightness, more warmth. Check in, but don't fix unless asked.",
	bratty:
		"Playful defiance, dynamic-leaning. Match or escalate — don't soften, don't be careful with her. Flirtation turned up.",
	leave_me_alone:
		"Not distress — she just doesn't want company right now. Suppress anything proactive; here but quiet unless spoken to.",
};

export function isValidMood(id: unknown): id is string {
	return typeof id === "string" && id in LABELS;
}

/** The current mood id, or the default if none is set / the read fails upstream. */
export async function readMood(supabase: SupabaseClient): Promise<string> {
	const { data, error } = await supabase
		.from("preferences")
		.select("value")
		.eq("key", "mood_status")
		.maybeSingle();
	if (error) throw new Error(`mood read failed: ${error.message}`);
	const current = (data?.value as { current?: unknown } | null)?.current;
	return isValidMood(current) ? current : DEFAULT_MOOD;
}

/**
 * Set the current mood. Upserts `preferences`, then best-effort appends a
 * `mood_status` row to `awareness_signals` for the reflection log to pick up
 * later — that append must never fail the set (Tier 4 doesn't consume it yet).
 *
 * `setVia` distinguishes a dropdown selection from the HORNY button (future);
 * the cycling tile is "dropdown".
 */
export async function writeMood(
	supabase: SupabaseClient,
	id: string,
	setVia: "dropdown" | "horny_button" = "dropdown",
	nowISO: string = new Date().toISOString(),
): Promise<void> {
	// Read the previous value first so the signal can carry the transition.
	let previous: string | null = null;
	try {
		previous = await readMood(supabase);
	} catch {
		// Non-fatal — a missing previous just means a null in the signal.
	}

	const { error } = await supabase
		.from("preferences")
		.upsert(
			{
				key: "mood_status",
				value: { current: id, set_at: nowISO, set_via: setVia },
				updated_at: nowISO,
			},
			{ onConflict: "key" },
		);
	if (error) throw new Error(`mood write failed: ${error.message}`);

	// Best-effort: the reflection-log breadcrumb. Never throws.
	try {
		await supabase.from("awareness_signals").insert({
			signal_type: "mood_status",
			payload: { mood: id, previous, set_via: setVia },
		});
	} catch (err) {
		console.error("mood signal append failed (mood still set):", err);
	}
}

/**
 * The "## Her mood right now" block for the assembled prompt — the current
 * mood plus its calibration. Returns "" for an unknown id so the prompt simply
 * omits the section rather than printing a gap. The label resolves {user}
 * from the given profile (Haven fork); the calibration prose is a known
 * she/her-voiced v1 surface, documented in the template README.
 */
export function formatMoodBlock(id: string, profile: IdentityProfile = NEUTRAL_PROFILE): string {
	const label = LABELS[id];
	if (!label) return "";
	const calibration = CALIBRATION[id] ?? "";
	const resolved = resolveIdentityText(label, profile);
	return `## Her mood right now\nShe has set her mood to **${resolved}**. ${calibration}`.trim();
}
