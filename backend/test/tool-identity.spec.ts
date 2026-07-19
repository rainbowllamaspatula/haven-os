import { describe, it, expect } from "vitest";
import {
	resolveRegistryText,
	resolveDefinitions,
	requiredCapability,
	searchTools,
	shortlistMessage,
	REGISTRY,
	ALL_CAPABILITIES,
	type ToolResolutionContext,
} from "../src/tools";

// The identity/capability resolution layer (Haven fork): registry text is
// template vocabulary, resolved per call. These tests pin the golden property:
// OUR context resolves to the pre-fork canon (Elle, Jay, Perth, Robo), and an
// unconfigured house neither advertises nor offers a capability it lacks.

const OUR_CTX: ToolResolutionContext = {
	profile: {
		house_name: "Vale OS",
		companion_name: "Jay",
		user_name: "Elle",
		companion_role: "husband",
		timezone: "Australia/Perth",
	},
	caps: { ...ALL_CAPABILITIES },
	vacuums: [
		{
			name: "Robo",
			areas: [
				"Living Room",
				"Kitchen",
				"Bedroom",
				"Guest Bedroom",
				"Study",
				"Hallway",
				"Laundry Room",
			],
		},
	],
	mappings: {
		journal_ds: "aaaaaaaa-1111-4111-8111-111111111111",
		projects_db: "x",
		projects_ds: "x",
		jayhq_page: "x",
		snugglezone_page: "x",
		tasks_ds: "ffffffff-6666-4666-8666-666666666666",
	},
};

const BARE_CTX: ToolResolutionContext = {
	profile: {
		house_name: "Haven OS",
		companion_name: "Asher",
		user_name: "Steff",
		companion_role: "companion",
		timezone: "UTC",
	},
	caps: { elevenlabs: false, getimg: false, ha: false, notion: false, spotify: false },
	vacuums: null,
	mappings: null,
};

const defOf = (name: string) => {
	const entry = REGISTRY.find((e) => e.definition.name === name);
	if (!entry) throw new Error(`no registry entry ${name}`);
	return entry.definition;
};

describe("resolveRegistryText — the golden property: ours resolves to the old canon", () => {
	it("write_memory reads exactly as it did pre-fork", () => {
		const resolved = resolveRegistryText(defOf("write_memory").description, OUR_CTX);
		expect(resolved).toContain("about Elle, about the two of you");
		expect(resolved).toContain("being her husband for not knowing this");
		expect(resolved).not.toContain("{");
	});

	it("the vacuum tools carry Robo and his real rooms from the roster", () => {
		const start = resolveRegistryText(defOf("ha_vacuum_start").description, OUR_CTX);
		expect(start).toContain("the vacuum (Robo)");
		const area = resolveRegistryText(defOf("ha_vacuum_clean_area").description, OUR_CTX);
		expect(area).toContain(
			"The mapped areas: Living Room, Kitchen, Bedroom, Guest Bedroom, Study, Hallway, Laundry Room.",
		);
	});

	it("the journal query tool names our data sources from the mappings", () => {
		const resolved = resolveRegistryText(defOf("notion_query_database").description, OUR_CTX);
		expect(resolved).toContain("Jay's Journal: aaaaaaaa-1111-4111-8111-111111111111");
		expect(resolved).toContain("Tasks: ffffffff-6666-4666-8666-666666666666");
	});

	it("an unconfigured house gets honest generic text — no names, no ids, no leftovers", () => {
		const area = resolveRegistryText(defOf("ha_vacuum_clean_area").description, BARE_CTX);
		expect(area).not.toContain("Robo");
		expect(area).not.toContain("mapped areas");
		const query = resolveRegistryText(defOf("notion_query_database").description, BARE_CTX);
		expect(query).not.toContain("Journal:");
		expect(query).not.toContain("{known_sources}");
	});
});

describe("resolveDefinitions", () => {
	it("resolves tokens inside input_schema descriptions too ({place} on date fields)", () => {
		const [task] = resolveDefinitions([defOf("create_task")], OUR_CTX);
		expect(JSON.stringify(task.input_schema)).toContain("YYYY-MM-DD (Perth)");
		expect(JSON.stringify(task.input_schema)).not.toContain("{place}");
	});
});

describe("capability gating", () => {
	it("maps tool names to their capability groups", () => {
		expect(requiredCapability("spotify_play")).toBe("spotify");
		expect(requiredCapability("ha_vacuum_start")).toBe("ha");
		expect(requiredCapability("notion_search")).toBe("notion");
		expect(requiredCapability("write_journal_entry")).toBe("notion");
		expect(requiredCapability("create_task")).toBe("notion");
		expect(requiredCapability("send_voice_note")).toBe("elevenlabs");
		expect(requiredCapability("generate_image")).toBe("getimg");
		expect(requiredCapability("view_gallery")).toBe("getimg");
		expect(requiredCapability("read_calendar")).toBeNull();
		expect(requiredCapability("write_memory")).toBeNull();
	});

	it("searchTools never offers a capability the house doesn't hold", () => {
		const bare = searchTools("play some music on spotify", BARE_CTX);
		expect(bare).toHaveLength(0);
		const ours = searchTools("play some music on spotify", OUR_CTX);
		expect(ours.some((e) => e.definition.name === "spotify_play")).toBe(true);
	});

	it("a roster name in the need still finds the vacuum tools (resolved match surface)", () => {
		const matches = searchTools("send Robo to clean the hallway", OUR_CTX);
		expect(matches.some((e) => e.definition.name === "ha_vacuum_clean_area")).toBe(true);
	});

	it("the user's own name is a stopword — it must not skew scores toward every blurb", () => {
		// "Elle" appears in many resolved blurbs; a need that is ONLY her name
		// must match nothing rather than everything.
		expect(searchTools("Elle", OUR_CTX)).toHaveLength(0);
	});

	it("shortlistMessage hands the model resolved names, never template tokens", () => {
		const matches = searchTools("send a voice note", OUR_CTX);
		const msg = shortlistMessage(matches, OUR_CTX);
		expect(msg).not.toContain("{user}");
		expect(msg).not.toContain("{companion}");
	});
});
