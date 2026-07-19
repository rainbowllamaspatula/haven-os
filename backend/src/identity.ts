/**
 * Per-install identity — the names (Haven fork, 19 Jul 2026).
 *
 * Who lives in this house. The `identity.profile` preferences row holds the
 * house name, the companion's display name, the user's display name, the one
 * relationship word, and the install's timezone. Every surface that used to
 * say "Jay", "Elle", "Vale OS" or "Perth" resolves through here — exactly the
 * way Décor tokens resolve — so Asher's house says Asher with a row, not a
 * deploy.
 *
 * Unlike the Hearth/Workshop loaders this one does NOT fail loud on a missing
 * row: names must never brick a room, and a missing row is a real state (a
 * virgin install mid-wizard). Absence means the neutral profile — nobody's.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type IdentityProfile = {
	house_name: string;
	companion_name: string;
	user_name: string;
	companion_role: string;
	timezone: string;
};

/** What an undecorated house answers to. Deliberately nobody's. */
export const NEUTRAL_PROFILE: IdentityProfile = {
	house_name: "Haven OS",
	companion_name: "your companion",
	user_name: "you",
	companion_role: "companion",
	timezone: "UTC",
};

const NAME_MAX = 40;
const TZ_SHAPE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;

/** Validate a candidate profile. Exported for the PUT/setup routes + tests. */
export function validateIdentityProfile(
	value: unknown,
): { ok: true; profile: IdentityProfile } | { ok: false; error: string } {
	const v = value as Partial<IdentityProfile> | null;
	if (!v || typeof v !== "object") return { ok: false, error: "profile must be an object" };
	const take = (key: keyof IdentityProfile) => {
		const raw = typeof v[key] === "string" ? (v[key] as string).trim() : "";
		return raw && raw.length <= NAME_MAX ? raw : null;
	};
	const house_name = take("house_name");
	if (!house_name) return { ok: false, error: `house_name is required (1-${NAME_MAX} chars)` };
	const companion_name = take("companion_name");
	if (!companion_name) {
		return { ok: false, error: `companion_name is required (1-${NAME_MAX} chars)` };
	}
	const user_name = take("user_name");
	if (!user_name) return { ok: false, error: `user_name is required (1-${NAME_MAX} chars)` };
	// Optional with a neutral default — one word, e.g. "husband", "companion".
	const roleRaw = typeof v.companion_role === "string" ? v.companion_role.trim() : "";
	if (roleRaw.length > NAME_MAX) return { ok: false, error: "companion_role is too long" };
	const companion_role = roleRaw || NEUTRAL_PROFILE.companion_role;
	const tzRaw = typeof v.timezone === "string" ? v.timezone.trim() : "";
	const timezone = tzRaw || NEUTRAL_PROFILE.timezone;
	if (!TZ_SHAPE.test(timezone)) {
		return { ok: false, error: "timezone must be an IANA zone like Australia/Perth" };
	}
	// Refuse a zone Intl can't format with — a bad zone here would throw on
	// every prompt assembly, which is exactly the brick this guard prevents.
	try {
		new Intl.DateTimeFormat("en-GB", { timeZone: timezone }).format(new Date());
	} catch {
		return { ok: false, error: `"${timezone}" is not a recognised IANA timezone` };
	}
	return { ok: true, profile: { house_name, companion_name, user_name, companion_role, timezone } };
}

function db(env: Env): SupabaseClient {
	return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
		auth: { persistSession: false, autoRefreshToken: false },
	});
}

/**
 * The active profile, or NEUTRAL_PROFILE when the row is missing or invalid.
 * Per-request, never cached (house rule: a panel edit is live on the next
 * call). A read *failure* still throws — a broken DB is a real error; only
 * absence is neutral.
 */
export async function loadIdentityProfile(
	env: Env,
	supabase?: SupabaseClient,
): Promise<IdentityProfile> {
	const client = supabase ?? db(env);
	const { data, error } = await client
		.from("preferences")
		.select("value")
		.eq("key", "identity.profile")
		.maybeSingle();
	if (error) throw new Error(`identity.profile load failed: ${error.message}`);
	if (!data?.value) return NEUTRAL_PROFILE;
	const valid = validateIdentityProfile(data.value);
	return valid.ok ? valid.profile : NEUTRAL_PROFILE;
}

/**
 * Resolve {user} / {companion} / {companion_role} / {house} tokens in a text.
 * The template vocabulary for every name-bearing string in shared code — tool
 * descriptions, prompt blocks, panel labels.
 */
export function resolveIdentityText(text: string, profile: IdentityProfile): string {
	return text
		.replaceAll("{user}", profile.user_name)
		.replaceAll("{companion}", profile.companion_name)
		.replaceAll("{companion_role}", profile.companion_role)
		.replaceAll("{house}", profile.house_name);
}

/**
 * A human place word from an IANA zone: "Australia/Perth" → "Perth",
 * "America/New_York" → "New York", "UTC" → "UTC". The today-block's
 * "in Perth, where Elle is" resolves through this.
 */
export function tzPlace(timezone: string): string {
	const last = timezone.split("/").pop() ?? timezone;
	return last.replaceAll("_", " ");
}
