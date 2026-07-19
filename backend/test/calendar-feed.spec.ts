import { describe, it, expect } from "vitest";
import { pickNext, type NextRow } from "../src/index";

// pickNext is the backend's "next event" feed-shaping rule. The review's original
// list named buildFeed/groupAgenda; the settled repo shapes the feed here (and the
// Perth-aware client does the bucketing), so this is the current successor.
//
// The rule: a timed event sorts by its instant; an all-day event sorts at the END
// of its Perth day (+24h). That reflects the gcal all-day convention — an all-day
// banner shouldn't shadow a same-day timed appointment just because midnight sorts
// first, but it should win once that timed event has passed or across days.

const timed = (title: string, startsAt: string): NextRow => ({ title, starts_at: startsAt, is_datetime: true });
const allDay = (title: string, startsAt: string): NextRow => ({ title, starts_at: startsAt, is_datetime: false });

describe("pickNext", () => {
	it("returns the all-day event when there is no timed candidate", () => {
		const a = allDay("Public holiday", "2026-07-16T00:00:00+08:00");
		expect(pickNext(null, a)).toBe(a);
	});

	it("returns the timed event when there is no all-day candidate", () => {
		const t = timed("Dentist", "2026-07-16T09:00:00+08:00");
		expect(pickNext(t, null)).toBe(t);
	});

	it("returns null when neither candidate exists", () => {
		expect(pickNext(null, null)).toBeNull();
	});

	it("surfaces a same-day timed appointment ahead of that day's all-day banner", () => {
		// Both on 16 Jul Perth: the 9am appointment should win over the all-day row,
		// because the all-day row is sorted to the END of 16 Jul (17 Jul midnight).
		const t = timed("Dentist", "2026-07-16T09:00:00+08:00");
		const a = allDay("Bin day", "2026-07-16T00:00:00+08:00");
		expect(pickNext(t, a)).toBe(t);
	});

	it("lets an all-day banner win over a timed event on a later day", () => {
		// All-day today (16 Jul) vs a timed event two days out (18 Jul). The all-day
		// row (sorted to end of 16 Jul) is sooner, so it wins.
		const t = timed("Flight", "2026-07-18T09:00:00+08:00");
		const a = allDay("Bin day", "2026-07-16T00:00:00+08:00");
		expect(pickNext(t, a)).toBe(a);
	});

	it("keeps the timed event at the exact end-of-Perth-day boundary (<=)", () => {
		// Timed event lands exactly at the all-day row's sort key (its Perth day's
		// end). The `<=` tie-break keeps the timed event.
		const a = allDay("Bin day", "2026-07-16T00:00:00+08:00");
		const endOfAllDayPerthDay = "2026-07-17T00:00:00+08:00"; // +24h from the all-day start
		const t = timed("Late thing", endOfAllDayPerthDay);
		expect(pickNext(t, a)).toBe(t);
	});
});
