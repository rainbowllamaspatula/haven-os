import { describe, it, expect } from "vitest";
import {
	validateHearthRegistry,
	validateWorkshopMappings,
	validateWorkshopBlocks,
	validateVacuumRoster,
	validateAudioRoster,
} from "../src/config";

const GOOD_REGISTRY = {
	scene_lights: ["Living Room Light Bar", "Bookcase", "TV Strip"],
	scenes: [
		{ name: "Off", icon: "ti-bulb-off", values: [0, 0, 0] },
		{ name: "Movie", icon: "ti-movie", values: [30, 15, 0] },
		{ name: "Ambient", icon: "ti-flame", values: [45, 60, 20] },
		{ name: "All on", icon: "ti-bulb", values: [100, 100, 100] },
	],
	goodnight: { light: "Bedroom", brightness: 20 },
};

const GOOD_MAPPINGS = {
	journal_ds: "aaaaaaaa-1111-4111-8111-111111111111",
	projects_db: "bbbbbbbb22224222a222222222222222", // undashed is legal
	projects_ds: "cccccccc-3333-4333-8333-333333333333",
	jayhq_page: "dddddddd-4444-4444-8444-444444444444",
	snugglezone_page: "eeeeeeee-5555-4555-8555-555555555555",
	tasks_ds: "ffffffff-6666-4666-8666-666666666666",
};

describe("validateHearthRegistry", () => {
	it("accepts the seeded shape", () => {
		const v = validateHearthRegistry(GOOD_REGISTRY);
		expect(v.ok).toBe(true);
	});

	it("ties scene arity to the light count — the invariant that keeps setScene sane", () => {
		const v = validateHearthRegistry({
			...GOOD_REGISTRY,
			scenes: [{ name: "Movie", icon: "ti-movie", values: [30, 15] }], // 2 values, 3 lights
		});
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.error).toContain('"Movie"');
	});

	it("rejects out-of-range brightness values", () => {
		const v = validateHearthRegistry({
			...GOOD_REGISTRY,
			scenes: [{ name: "Ambient", icon: "ti-flame", values: [45, 60, 120] }],
		});
		expect(v.ok).toBe(false);
	});

	it("scenes are fully config: arbitrary names welcome, duplicates and blanks refused", () => {
		const reading = validateHearthRegistry({
			...GOOD_REGISTRY,
			scenes: [...GOOD_REGISTRY.scenes, { name: "Reading", icon: "ti-book", values: [10, 80, 0] }],
		});
		expect(reading.ok).toBe(true);
		if (reading.ok) expect(reading.registry.scenes.map((s) => s.name)).toContain("Reading");
		expect(
			validateHearthRegistry({
				...GOOD_REGISTRY,
				scenes: [
					{ name: "Movie", icon: "ti-movie", values: [1, 1, 1] },
					{ name: "movie", icon: "ti-movie", values: [2, 2, 2] }, // case-insensitive dupe
				],
			}).ok,
		).toBe(false);
		expect(
			validateHearthRegistry({
				...GOOD_REGISTRY,
				scenes: [{ name: "  ", icon: "ti-bulb", values: [0, 0, 0] }],
			}).ok,
		).toBe(false);
	});

	it("a dodgy icon falls back to ti-bulb instead of failing the save", () => {
		const v = validateHearthRegistry({
			...GOOD_REGISTRY,
			scenes: [{ name: "Weird", icon: "javascript:alert(1)", values: [0, 0, 0] }],
		});
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.registry.scenes[0].icon).toBe("ti-bulb");
	});

	it("rejects duplicate and empty light names", () => {
		expect(
			validateHearthRegistry({
				...GOOD_REGISTRY,
				scene_lights: ["Bookcase", "Bookcase", "TV Strip"],
			}).ok,
		).toBe(false);
		expect(validateHearthRegistry({ ...GOOD_REGISTRY, scene_lights: [] }).ok).toBe(false);
	});

	it("requires a goodnight light and a sane brightness", () => {
		expect(
			validateHearthRegistry({ ...GOOD_REGISTRY, goodnight: { light: "", brightness: 20 } }).ok,
		).toBe(false);
		expect(
			validateHearthRegistry({ ...GOOD_REGISTRY, goodnight: { light: "Bedroom", brightness: 101 } }).ok,
		).toBe(false);
	});
});

// ── The 18 Jul roster extension ──────────────────────────────────────────────

const GOOD_VACUUMS = [
	{
		name: "Robo",
		areas: ["Living Room", "Kitchen", "Bedroom", "Guest Bedroom", "Study", "Hallway", "Laundry Room"],
	},
];

const GOOD_AUDIO = {
	everywhere: "Everywhere",
	areas: [
		{ area: "Living Room", speakers: ["Living Room TV"] },
		{ area: "Bedroom", speakers: ["Bedroom"] },
		{ area: "Guest Bedroom", speakers: ["Guest Bedroom Echo"] },
	],
};

describe("validateVacuumRoster", () => {
	it("accepts the seeded shape", () => {
		const v = validateVacuumRoster(GOOD_VACUUMS);
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.vacuums[0].areas).toHaveLength(7);
	});

	it("a vacuum with no areas is legal — whole-house clean only", () => {
		expect(validateVacuumRoster([{ name: "Robo", areas: [] }]).ok).toBe(true);
	});

	it("supports several vacuums but rejects a duplicate name", () => {
		const two = validateVacuumRoster([
			{ name: "Robo", areas: ["Kitchen"] },
			{ name: "Yzma", areas: ["Study"] },
		]);
		expect(two.ok).toBe(true);
		expect(
			validateVacuumRoster([
				{ name: "Robo", areas: [] },
				{ name: "Robo", areas: [] }, // case-insensitive dupe
			]).ok,
		).toBe(false);
	});

	it("rejects a duplicate or blank area within one vacuum, naming it", () => {
		const dupe = validateVacuumRoster([{ name: "Robo", areas: ["Study", "study"] }]);
		expect(dupe.ok).toBe(false);
		if (!dupe.ok) expect(dupe.error).toMatch(/study/i); // named as typed the second time
		expect(validateVacuumRoster([{ name: "Robo", areas: [" "] }]).ok).toBe(false);
	});

	it("rejects an empty roster and a nameless vacuum", () => {
		expect(validateVacuumRoster([]).ok).toBe(false);
		expect(validateVacuumRoster([{ name: "", areas: [] }]).ok).toBe(false);
	});
});

describe("validateAudioRoster", () => {
	it("accepts the seeded shape", () => {
		const v = validateAudioRoster(GOOD_AUDIO);
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.audio.everywhere).toBe("Everywhere");
	});

	it("everywhere is optional — null means no whole-house group", () => {
		const v = validateAudioRoster({ ...GOOD_AUDIO, everywhere: null });
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.audio.everywhere).toBeNull();
	});

	it("holds the two-level shape: several speakers nest under one area (the VHS proof)", () => {
		const v = validateAudioRoster({
			...GOOD_AUDIO,
			areas: [...GOOD_AUDIO.areas, { area: "Studio", speakers: ["Left Sonos", "Right Sonos"] }],
		});
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.audio.areas.find((a) => a.area === "Studio")?.speakers).toHaveLength(2);
	});

	it("an area with no speakers cannot exist", () => {
		expect(
			validateAudioRoster({ ...GOOD_AUDIO, areas: [{ area: "Kitchen", speakers: [] }] }).ok,
		).toBe(false);
	});

	it("one speaker lives in one area", () => {
		const v = validateAudioRoster({
			...GOOD_AUDIO,
			areas: [
				{ area: "Bedroom", speakers: ["Echo"] },
				{ area: "Study", speakers: ["echo"] }, // case-insensitive dupe
			],
		});
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.error).toContain("two areas");
	});

	it("the Everywhere group is never also inside an area", () => {
		const v = validateAudioRoster({
			everywhere: "Everywhere",
			areas: [{ area: "Bedroom", speakers: ["Everywhere"] }],
		});
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.error).toContain("Everywhere");
	});

	it("rejects a duplicate area name", () => {
		expect(
			validateAudioRoster({
				...GOOD_AUDIO,
				areas: [
					{ area: "Bedroom", speakers: ["A"] },
					{ area: "bedroom", speakers: ["B"] },
				],
			}).ok,
		).toBe(false);
	});
});

// ── Generic parent blocks (18 Jul) ───────────────────────────────────────────

const GOOD_BLOCK = {
	name: "Assessments",
	icon: "ti-school",
	sources: [
		{
			data_source_id: "cccccccc-3333-4333-8333-333333333333",
			accent: "teal",
			properties: ["Status", "Due"],
		},
		{
			data_source_id: "aaaaaaaa-1111-4111-8111-111111111111",
			accent: "bronze",
			properties: ["Taught", "Topics"],
		},
	],
	sort: { property: "Due", direction: "asc" },
};

describe("validateWorkshopBlocks", () => {
	it("accepts a multi-source block, and an empty array (the seeded state)", () => {
		const v = validateWorkshopBlocks([GOOD_BLOCK]);
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.blocks[0].sources).toHaveLength(2);
		expect(validateWorkshopBlocks([]).ok).toBe(true);
	});

	it("accents are VDS names only — no hex sneaks in (acceptance 5)", () => {
		const v = validateWorkshopBlocks([
			{
				...GOOD_BLOCK,
				sources: [{ ...GOOD_BLOCK.sources[0], accent: "#ff00ff" }],
			},
		]);
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.error).toContain("accent");
	});

	it("a bespoke tool's name can't be shadowed", () => {
		expect(validateWorkshopBlocks([{ ...GOOD_BLOCK, name: "Projects" }]).ok).toBe(false);
		expect(validateWorkshopBlocks([{ ...GOOD_BLOCK, name: "notion" }]).ok).toBe(false);
	});

	it("rejects duplicate block names, duplicate sources, and non-uuid source ids", () => {
		expect(validateWorkshopBlocks([GOOD_BLOCK, { ...GOOD_BLOCK, name: "assessments" }]).ok).toBe(false);
		expect(
			validateWorkshopBlocks([
				{ ...GOOD_BLOCK, sources: [GOOD_BLOCK.sources[0], GOOD_BLOCK.sources[0]] },
			]).ok,
		).toBe(false);
		expect(
			validateWorkshopBlocks([
				{ ...GOOD_BLOCK, sources: [{ ...GOOD_BLOCK.sources[0], data_source_id: "not-an-id" }] },
			]).ok,
		).toBe(false);
	});

	it("a block needs at least one source; sort defaults land (title asc)", () => {
		expect(validateWorkshopBlocks([{ ...GOOD_BLOCK, sources: [] }]).ok).toBe(false);
		const v = validateWorkshopBlocks([{ ...GOOD_BLOCK, sort: undefined }]);
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.blocks[0].sort).toEqual({ property: "title", direction: "asc" });
	});

	it("a dodgy icon falls back to ti-database instead of failing the save", () => {
		const v = validateWorkshopBlocks([{ ...GOOD_BLOCK, icon: "javascript:alert(1)" }]);
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.blocks[0].icon).toBe("ti-database");
	});
});

describe("validateWorkshopMappings", () => {
	it("accepts the seeded shape, dashed or undashed", () => {
		expect(validateWorkshopMappings(GOOD_MAPPINGS).ok).toBe(true);
	});

	it("rejects a missing field, naming it", () => {
		const { tasks_ds: _dropped, ...partial } = GOOD_MAPPINGS;
		const v = validateWorkshopMappings(partial);
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.error).toContain("tasks_ds");
	});

	it("rejects a non-uuid value, naming the field", () => {
		const v = validateWorkshopMappings({ ...GOOD_MAPPINGS, journal_ds: "https://notion.so/paste-mistake" });
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.error).toContain("journal_ds");
	});
});
