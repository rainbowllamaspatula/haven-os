import { describe, it, expect } from "vitest";
import { extractProp, buildTile, mergeAndSort, sortKey } from "../src/workshop-blocks";
import type { NotionPage } from "../src/projects";

// Pages shaped like the live 2025-09-03 query payload (types + option colours
// verified against the API reference, 18 Jul). Two "databases" with different
// property names — the multi-source shape the brief is built around.
const assessmentPage = (id: string, title: string, due: string | null, status: string, color: string): NotionPage =>
	({
		id,
		url: `https://notion.so/${id}`,
		properties: {
			Name: { type: "title", title: [{ plain_text: title }] },
			Due: { type: "date", date: due ? { start: due } : null },
			Status: { type: "status", status: { name: status, color } },
			Owner: { type: "people", people: [] }, // unsupported on purpose
		},
	}) as unknown as NotionPage;

const lessonPage = (id: string, title: string, when: string | null, tags: Array<[string, string]>): NotionPage =>
	({
		id,
		url: `https://notion.so/${id}`,
		properties: {
			Lesson: { type: "title", title: [{ plain_text: title }] },
			Taught: { type: "date", date: when ? { start: when } : null },
			Topics: { type: "multi_select", multi_select: tags.map(([name, color]) => ({ name, color })) },
		},
	}) as unknown as NotionPage;

describe("extractProp — five types render, the rest dash", () => {
	const page = assessmentPage("a1", "Yr9 Test", "2026-07-25", "Marking", "orange");
	const props = page.properties as Record<string, never>;

	it("date renders as its raw start", () => {
		expect(extractProp("Due", props["Due"])).toEqual({ name: "Due", kind: "date", value: "2026-07-25" });
	});

	it("status is one chip wearing Notion's own colour", () => {
		expect(extractProp("Status", props["Status"])).toEqual({
			name: "Status",
			kind: "chips",
			chips: [{ label: "Marking", color: "orange" }],
		});
	});

	it("an unsupported type is an honest dash — never a guess (Asher-proofing)", () => {
		expect(extractProp("Owner", props["Owner"])).toEqual({ name: "Owner", kind: "dash" });
	});

	it("a property the page doesn't have at all is a dash too", () => {
		expect(extractProp("Ghost", undefined)).toEqual({ name: "Ghost", kind: "dash" });
	});

	it("multi_select renders every option as a coloured chip", () => {
		const lesson = lessonPage("l1", "Cells", "2026-07-20", [["Biology", "green"], ["Prac", "blue"]]);
		const p = (lesson.properties as Record<string, never>)["Topics"];
		expect(extractProp("Topics", p)).toEqual({
			name: "Topics",
			kind: "chips",
			chips: [
				{ label: "Biology", color: "green" },
				{ label: "Prac", color: "blue" },
			],
		});
	});
});

describe("buildTile — per-source property selection", () => {
	it("two sources choose DIFFERENT properties and each tile obeys its own source's list", () => {
		const a = buildTile(assessmentPage("a1", "Yr9 Test", "2026-07-25", "Marking", "orange"), "ds-a", ["Status", "Due"]);
		const l = buildTile(lessonPage("l1", "Cells", "2026-07-20", [["Biology", "green"]]), "ds-b", ["Taught", "Topics"]);
		expect(a.title).toBe("Yr9 Test");
		expect(a.source).toBe("ds-a");
		expect(a.props.map((p) => p.name)).toEqual(["Status", "Due"]);
		expect(l.props.map((p) => p.name)).toEqual(["Taught", "Topics"]);
	});

	it("a differently-named title property still heads the tile", () => {
		const l = buildTile(lessonPage("l1", "Cells", null, []), "ds-b", []);
		expect(l.title).toBe("Cells"); // title prop is "Lesson", not "Name"
	});
});

describe("mergeAndSort — one combined list, sorted by the chosen property", () => {
	// Sort properties are named differently per source; the sort key resolves
	// per tile, so a shared MEANING ("when") works across different NAMES only
	// when the block sorts by a name both sides carry — here we sort each
	// source's date property under its own name to prove nulls-last + order.
	const tiles = [
		buildTile(assessmentPage("a1", "Yr9 Test", "2026-07-25", "Marking", "orange"), "ds-a", ["Due"]),
		buildTile(assessmentPage("a2", "Yr7 Quiz", null, "Set", "gray"), "ds-a", ["Due"]),
		buildTile(assessmentPage("a3", "Yr11 Exam", "2026-07-20", "Set", "gray"), "ds-a", ["Due"]),
	];

	it("ascending by date, undated last — 'what's due next' opens the list", () => {
		const sorted = mergeAndSort(tiles, { property: "Due", direction: "asc" });
		expect(sorted.map((t) => t.id)).toEqual(["a3", "a1", "a2"]);
	});

	it("descending flips the dated, keeps the undated last", () => {
		const sorted = mergeAndSort(tiles, { property: "Due", direction: "desc" });
		expect(sorted.map((t) => t.id)).toEqual(["a1", "a3", "a2"]);
	});

	it("title sort works for every tile regardless of source shape", () => {
		const mixed = [
			buildTile(lessonPage("l1", "Cells", null, []), "ds-b", []),
			buildTile(assessmentPage("a1", "Acids", null, "Set", "gray"), "ds-a", []),
		];
		const sorted = mergeAndSort(mixed, { property: "title", direction: "asc" });
		expect(sorted.map((t) => t.title)).toEqual(["Acids", "Cells"]);
	});

	it("sortKey falls back to null (sorts last) for a property a tile doesn't show", () => {
		const l = buildTile(lessonPage("l1", "Cells", "2026-07-20", []), "ds-b", ["Taught"]);
		expect(sortKey(l, "Due")).toBeNull();
	});
});
