import { describe, it, expect } from "vitest";
import { parseLiveContext, normaliseHome, interpretAreaProbe } from "../src/home";

// A trimmed slice of the real GetLiveContext blob (probed 18 Jul 2026) — the
// shapes the rosters lean on: speakers carrying their area, the Everywhere
// group carrying none, the TV's duplicate blocks (one with device_class, one
// with nothing), and a vacuum block that says nothing but name and state.
const BLOB = `Live Context: An overview of the areas and the devices in this smart home:
- names: Bedroom
  domain: media_player
  state: paused
  areas: Bedroom
  attributes:
    volume_level: 0.17
- names: Everywhere
  domain: media_player
  state: idle
- names: Guest Bedroom Echo
  domain: media_player
  state: idle
  areas: Guest Bedroom
  attributes:
    volume_level: 0.35
- names: Robo
  domain: vacuum
  state: docked
- names: Living Room TV
  domain: media_player
  state: unavailable
  areas: Living Room
  attributes:
    device_class: tv
- names: Living Room TV
  domain: media_player
  state: unavailable
  areas: Living Room
- names: This Device
  domain: media_player
  state: idle
`;

describe("normaliseHome — the roster-facing read", () => {
	const home = normaliseHome(parseLiveContext(BLOB));

	it("returns every vacuum, name + state only (HA offers nothing more)", () => {
		expect(home.vacuums).toEqual([{ name: "Robo", state: "docked" }]);
	});

	it("speakers carry their HA area; the Everywhere group carries none", () => {
		const byName = Object.fromEntries(home.media.map((m) => [m.name, m]));
		expect(byName["Bedroom"].area).toBe("Bedroom");
		expect(byName["Guest Bedroom Echo"].area).toBe("Guest Bedroom");
		expect(byName["Everywhere"].area).toBeNull();
	});

	it("the TV's duplicate blocks merge, keeping the device_class kind", () => {
		const tvs = home.media.filter((m) => m.name === "Living Room TV");
		expect(tvs).toHaveLength(1);
		expect(tvs[0].kind).toBe("tv");
	});

	it("a plain speaker is kind speaker, and This Device stays dropped", () => {
		expect(home.media.find((m) => m.name === "Bedroom")?.kind).toBe("speaker");
		expect(home.media.some((m) => m.name === "This Device")).toBe(false);
	});
});

describe("interpretAreaProbe — the typed-area oracle (answers probed live 18 Jul)", () => {
	it("'does not exist' is the one true invalid", () => {
		const r = interpretAreaProbe(
			JSON.stringify({ success: false, error: "Area 'Narnia' does not exist" }),
		);
		expect(r.valid).toBe(false);
		expect(r.reason).toContain("Narnia");
	});

	it("a real-but-empty area is valid — exists, just nothing exposed in it", () => {
		const r = interpretAreaProbe(
			JSON.stringify({ success: false, error: "No exposed entities found in area 'Study'" }),
		);
		expect(r.valid).toBe(true);
	});

	it("a populated area (entity blob back) is valid", () => {
		expect(interpretAreaProbe(JSON.stringify({ success: true, result: "Live Context: …" })).valid).toBe(
			true,
		);
		expect(interpretAreaProbe("Live Context: plain text blob").valid).toBe(true);
	});

	it("an unrecognised failure THROWS — 'couldn't check' must never read as 'invalid'", () => {
		expect(() =>
			interpretAreaProbe(JSON.stringify({ success: false, error: "everything is on fire" })),
		).toThrow(/doesn't recognise/);
	});
});
