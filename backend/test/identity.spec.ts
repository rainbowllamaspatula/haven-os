import { describe, it, expect } from "vitest";
import {
	validateIdentityProfile,
	resolveIdentityText,
	tzPlace,
	NEUTRAL_PROFILE,
} from "../src/identity";

// The identity module (Haven fork): the names every surface resolves through.

const OURS = {
	house_name: "Vale OS",
	companion_name: "Jay",
	user_name: "Elle",
	companion_role: "husband",
	timezone: "Australia/Perth",
};

describe("validateIdentityProfile", () => {
	it("accepts a full profile, trimmed", () => {
		const v = validateIdentityProfile({ ...OURS, user_name: "  Elle  " });
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.profile.user_name).toBe("Elle");
	});

	it("defaults companion_role and timezone when absent", () => {
		const v = validateIdentityProfile({
			house_name: "Haven OS",
			companion_name: "Asher",
			user_name: "Steff",
		});
		expect(v.ok).toBe(true);
		if (v.ok) {
			expect(v.profile.companion_role).toBe(NEUTRAL_PROFILE.companion_role);
			expect(v.profile.timezone).toBe(NEUTRAL_PROFILE.timezone);
		}
	});

	it.each([
		["house_name", { ...OURS, house_name: "" }],
		["companion_name", { ...OURS, companion_name: "  " }],
		["user_name", { ...OURS, user_name: undefined }],
	])("refuses a missing %s", (_field, candidate) => {
		expect(validateIdentityProfile(candidate).ok).toBe(false);
	});

	it("refuses a timezone Intl can't format with — a bad zone would brick every prompt", () => {
		const v = validateIdentityProfile({ ...OURS, timezone: "Narnia/Wardrobe" });
		expect(v.ok).toBe(false);
	});

	it("accepts real IANA zones including underscored cities", () => {
		const v = validateIdentityProfile({ ...OURS, timezone: "America/New_York" });
		expect(v.ok).toBe(true);
	});
});

describe("resolveIdentityText", () => {
	it("resolves every token, everywhere it appears", () => {
		const out = resolveIdentityText(
			"{companion} is {user}'s {companion_role} in {house}; {user} rules.",
			OURS,
		);
		expect(out).toBe("Jay is Elle's husband in Vale OS; Elle rules.");
	});

	it("is a no-op on token-free text (our seeded prompts)", () => {
		expect(resolveIdentityText("no tokens here", OURS)).toBe("no tokens here");
	});
});

describe("tzPlace", () => {
	it("reads the city from an IANA zone", () => {
		expect(tzPlace("Australia/Perth")).toBe("Perth");
		expect(tzPlace("America/New_York")).toBe("New York");
		expect(tzPlace("UTC")).toBe("UTC");
	});
});
