import { describe, it, expect } from "vitest";
import { perthMidnightToday, perthDate } from "../src/index";

// Perth is UTC+8, no DST. Perth-midnight of calendar date D is 16:00 UTC on D-1.
// These helpers are the codebase's highest-value regression targets: the class of
// bug they guard against is the "double-shift" (applying the +8h offset twice, or
// mixing UTC-midnight with Perth-midnight), which lands a capture on the wrong day
// around the midnight boundary. Cases below sit deliberately on both sides of it.

describe("perthMidnightToday", () => {
	it("returns the UTC instant of Perth-midnight for the day containing `now`", () => {
		// Perth 12:00 on 16 Jul → Perth-midnight of 16 Jul = 15 Jul 16:00 UTC.
		const now = new Date("2026-07-16T04:00:00Z");
		expect(perthMidnightToday(now)).toBe("2026-07-15T16:00:00.000Z");
	});

	it("is stable across the whole Perth day (start and end resolve identically)", () => {
		// 16:00 UTC = Perth 00:00 (start of 16 Jul); 15:59:59 UTC next day = Perth
		// 23:59:59 (end of 16 Jul). Both must anchor to the same Perth-midnight.
		const startOfPerthDay = perthMidnightToday(new Date("2026-07-15T16:00:00Z"));
		const endOfPerthDay = perthMidnightToday(new Date("2026-07-16T15:59:59Z"));
		expect(startOfPerthDay).toBe("2026-07-15T16:00:00.000Z");
		expect(endOfPerthDay).toBe(startOfPerthDay);
	});

	it("rolls to the previous Perth day one second before Perth-midnight", () => {
		// 15:59:59 UTC = Perth 23:59:59 on 15 Jul → Perth-midnight of 15 Jul.
		const justBeforeMidnight = new Date("2026-07-15T15:59:59Z");
		expect(perthMidnightToday(justBeforeMidnight)).toBe("2026-07-14T16:00:00.000Z");
	});
});

describe("perthDate - Wave 1 double-shift regression", () => {
	// A "Today" capture (offsetDays = 0) at various UTC times must land on the
	// correct Perth calendar date. Perth-midnight of 16 Jul is 15 Jul 16:00 UTC.
	it("stays on 15 Jul one second before Perth-midnight", () => {
		expect(perthDate(new Date("2026-07-15T15:59:59Z"), 0)).toBe("2026-07-15");
	});

	it("flips to 16 Jul exactly at Perth-midnight", () => {
		expect(perthDate(new Date("2026-07-15T16:00:00Z"), 0)).toBe("2026-07-16");
	});

	it("is 16 Jul just after Perth-midnight", () => {
		expect(perthDate(new Date("2026-07-15T16:00:01Z"), 0)).toBe("2026-07-16");
	});

	it("does not double-shift a mid-afternoon Perth time into the next day", () => {
		// Perth 17:00 on 16 Jul — unambiguously still 16 Jul. A double-applied +8h
		// (i.e. +16h) offset would wrongly report 17 Jul here; the correct helper
		// reports 16 Jul.
		expect(perthDate(new Date("2026-07-16T09:00:00Z"), 0)).toBe("2026-07-16");
	});

	it("holds the Perth date across the last UTC hours of the Perth day", () => {
		// Perth 23:59:59 on 16 Jul is still 16 Jul, not yet 17 Jul.
		expect(perthDate(new Date("2026-07-16T15:59:59Z"), 0)).toBe("2026-07-16");
	});
});

describe("perthDate - agenda-window offsets", () => {
	// The agenda route pads its window a Perth day each side (offsetDays = -1 and
	// horizon + 1) and lets the client bucket. Offsets must respect month/year ends.
	const now = new Date("2026-07-16T04:00:00Z"); // Perth 12:00, 16 Jul

	it("subtracts a day for the lower pad", () => {
		expect(perthDate(now, -1)).toBe("2026-07-15");
	});

	it("adds the 31-day horizon across a month boundary", () => {
		expect(perthDate(now, 31)).toBe("2026-08-16");
	});

	it("rolls over the end of a month", () => {
		// Perth 12:00 on 31 Jul, +1 day → 1 Aug.
		expect(perthDate(new Date("2026-07-31T04:00:00Z"), 1)).toBe("2026-08-01");
	});

	it("rolls over the end of a year", () => {
		// Perth 12:00 on 31 Dec, +1 day → 1 Jan next year.
		expect(perthDate(new Date("2026-12-31T04:00:00Z"), 1)).toBe("2027-01-01");
	});
});
