import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
	hashPassword,
	checkHousePassword,
	setupRequired,
	storePassword,
} from "../src/setup";

// First-run setup (Haven fork). auth.ts is untouched — these tests pin the
// wiring AROUND it: env password wins byte-for-byte, hash path only when the
// env secret is absent, and our install can never present as virgin.

// A preferences table stub: auth.password row present or absent.
const dbWith = (row: unknown | null, inserts: unknown[] = []): SupabaseClient =>
	({
		from: () => ({
			select: () => ({
				eq: () => ({
					maybeSingle: async () => ({ data: row === null ? null : { value: row }, error: null }),
				}),
			}),
			insert: async (v: unknown) => {
				inserts.push(v);
				return { error: null };
			},
		}),
	}) as unknown as SupabaseClient;

const ENV_WITH_PASSWORD = { VALE_PASSWORD: "our-house-password" } as unknown as Env;
const ENV_WITHOUT = { VALE_PASSWORD: "" } as unknown as Env;

describe("checkHousePassword", () => {
	it("env password wins — exact match passes, wrong fails, DB never consulted", async () => {
		// A db stub that throws if touched: the env path must not read it.
		const explosive = {
			from: () => {
				throw new Error("the env path must never read the DB");
			},
		} as unknown as SupabaseClient;
		expect(await checkHousePassword(ENV_WITH_PASSWORD, explosive, "our-house-password")).toBe(true);
		expect(await checkHousePassword(ENV_WITH_PASSWORD, explosive, "wrong")).toBe(false);
	});

	it("hash path: a stored PBKDF2 row verifies the right password and refuses the wrong one", async () => {
		const stored = await hashPassword("steffs-password");
		const db = dbWith(stored);
		expect(await checkHousePassword(ENV_WITHOUT, db, "steffs-password")).toBe(true);
		expect(await checkHousePassword(ENV_WITHOUT, db, "not-it")).toBe(false);
	});

	it("no env password and no row = nothing passes (never an open door)", async () => {
		const db = dbWith(null);
		expect(await checkHousePassword(ENV_WITHOUT, db, "")).toBe(false);
		expect(await checkHousePassword(ENV_WITHOUT, db, "anything")).toBe(false);
	});
});

describe("setupRequired", () => {
	it("an env-password install (ours) is never virgin — no DB read", async () => {
		const explosive = {
			from: () => {
				throw new Error("must not be read");
			},
		} as unknown as SupabaseClient;
		expect(await setupRequired(ENV_WITH_PASSWORD, explosive)).toBe(false);
	});

	it("no env password + no stored hash = virgin", async () => {
		expect(await setupRequired(ENV_WITHOUT, dbWith(null))).toBe(true);
	});

	it("no env password + a stored hash = configured", async () => {
		expect(await setupRequired(ENV_WITHOUT, dbWith(await hashPassword("x".repeat(10))))).toBe(false);
	});
});

describe("storePassword", () => {
	it("refuses a short password", async () => {
		const r = await storePassword(dbWith(null), "short");
		expect(r.ok).toBe(false);
	});

	it("refuses to overwrite — setup runs once", async () => {
		const r = await storePassword(dbWith(await hashPassword("already-set-1")), "new-password-1");
		expect(r).toEqual({ ok: false, error: "A password is already set — setup has already run." });
	});

	it("stores a salted PBKDF2 record for a fresh install", async () => {
		const inserts: Array<{ key: string; value: { algo: string; salt: string; hash: string } }> = [];
		const r = await storePassword(dbWith(null, inserts), "a-good-password");
		expect(r).toEqual({ ok: true });
		expect(inserts).toHaveLength(1);
		expect(inserts[0].key).toBe("auth.password");
		expect(inserts[0].value.algo).toBe("pbkdf2-sha256");
		expect(inserts[0].value.salt).toMatch(/^[0-9a-f]{32}$/);
		expect(inserts[0].value.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("two hashes of the same password differ (fresh salt each time)", async () => {
		const a = await hashPassword("same-password");
		const b = await hashPassword("same-password");
		expect(a.salt).not.toBe(b.salt);
		expect(a.hash).not.toBe(b.hash);
	});
});
