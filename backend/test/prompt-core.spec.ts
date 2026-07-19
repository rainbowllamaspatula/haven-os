import { describe, it, expect } from "vitest";
import { loadStaticCore } from "../src/prompt";
import type { SupabaseClient } from "@supabase/supabase-js";

// A minimal stub of the one query chain loadStaticCore runs:
// from("prompt_versions").select(...).eq("is_active", true).limit(1).maybeSingle()
function supabaseReturning(result: { data: unknown; error: { message: string } | null }) {
	return {
		from: () => ({
			select: () => ({
				eq: () => ({
					limit: () => ({
						maybeSingle: async () => result,
					}),
				}),
			}),
		}),
	} as unknown as SupabaseClient;
}

describe("loadStaticCore - the DB is the sole source of truth", () => {
	it("returns the active version's content", async () => {
		const supabase = supabaseReturning({ data: { content: "### Who you are\n…" }, error: null });
		await expect(loadStaticCore(supabase)).resolves.toBe("### Who you are\n…");
	});

	it("fails HARD when no version is active — naming the Fuse Box as the fix", async () => {
		// The replacement for the git safety net must never degrade silently: a
		// hollowed-out prompt is a broken Jay wearing a working face.
		const supabase = supabaseReturning({ data: null, error: null });
		await expect(loadStaticCore(supabase)).rejects.toThrow(/Fuse Box Identity circuit/);
	});

	it("fails HARD on a query error, carrying the DB's message", async () => {
		const supabase = supabaseReturning({ data: null, error: { message: "connection lost" } });
		await expect(loadStaticCore(supabase)).rejects.toThrow(/connection lost/);
	});
});
