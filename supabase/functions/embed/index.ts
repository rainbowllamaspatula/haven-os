// Vale OS — the embedding primitive.
//
// One central embedder, reused by the Worker's read path and write_memory — the
// single place embeddings are produced. As of 28 Jun 2026 this calls
// gemini-embedding-001 via OpenRouter (1536-dim): gte-small's resolution ceiling
// smeared close-but-distinct facts (colleague/family, the false-close matches
// behind the write_memory merge bug), so the curated layer moved to a stronger
// model. The embed call now leaves the Edge Runtime for an external OpenRouter
// request — a trade-off the migration brief accepted, incl. on the per-turn
// retrieval hot path (which is best-effort upstream, so a failure costs no reply).
//
// gemini-embedding-001 does NOT auto-normalize when its output is truncated below
// 3072 dims, so this L2-normalizes the 1536 vector itself (gte-small did this for
// us via normalize:true). Cosine distance is scale-invariant so ranking is fine
// either way, but unit vectors match Google's guidance and any future dot-product.
//
// Auth: verify_jwt is on; the Worker calls with the service-role key.
// OPENROUTER_API_KEY is a Supabase secret.
//
// Deployed to Supabase via tooling; this copy is the version-controlled source.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/embeddings";
const EMBED_MODEL = "google/gemini-embedding-001";
const EMBED_DIMS = 1536;
// verify_jwt only proves the caller holds *a* valid project key — anon/publishable
// included. This is a service-role-only primitive, so we additionally require a
// SERVER-SIDE credential below. And we cap input length so a stray caller can't
// turn one request into a large OpenRouter bill.
const MAX_TEXT = 8_000;

// Is this a server-side (privileged) caller? Only two credential types are:
//   - the new-format secret key, "sb_secret_…" (what the Worker holds here), and
//   - the legacy service_role JWT (role claim === "service_role").
// The client-exposed keys — legacy anon JWT, "sb_publishable_…" — are rejected.
// Format-aware on purpose: this project is on the new API-key system, so the
// Worker's key is NOT a JWT. A role-claim-only check (the first cut of this
// hardening) rejected the sb_secret_ key and silently broke memory + retrieval;
// this fixes that (15 Jul 2026) while still keeping anon/publishable out.
function isServiceCall(req: Request): { ok: boolean; fmt: string } {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return { ok: false, fmt: "none" };
  if (token.startsWith("sb_secret_")) return { ok: true, fmt: "sb_secret" };
  if (token.startsWith("sb_publishable_")) return { ok: false, fmt: "sb_publishable" };
  // Legacy JWT: accept only role=service_role. Signature already trusted
  // (verify_jwt validated it upstream); this only reads the payload segment.
  const seg = token.split(".")[1];
  if (!seg) return { ok: false, fmt: "opaque" };
  try {
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const payload = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(b64 + pad), (c) => c.charCodeAt(0))),
    ) as { role?: unknown };
    return { ok: payload.role === "service_role", fmt: `jwt:${String(payload.role)}` };
  } catch {
    return { ok: false, fmt: "jwt-parse-error" };
  }
}

// text -> 1536-dim L2-normalized vector via gemini-embedding-001 on OpenRouter.
async function embed(text: string): Promise<number[]> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("OPENROUTER_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text, dimensions: EMBED_DIMS }),
    // Don't let a hung OpenRouter socket hang the caller (retrieval is on the
    // reply hot path). A separate Deno function, so the timeout is inline rather
    // than backend/src/http.ts's shared helper.
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { data?: { embedding?: number[] }[] };
  const vec = data?.data?.[0]?.embedding;
  if (!Array.isArray(vec) || vec.length !== EMBED_DIMS) {
    throw new Error(
      `OpenRouter returned ${Array.isArray(vec) ? vec.length : "no"} dims, expected ${EMBED_DIMS}`,
    );
  }
  // L2-normalize — gemini-embedding-001 leaves truncated dims un-normalized.
  let sumSq = 0;
  for (const x of vec) sumSq += x * x;
  const norm = Math.sqrt(sumSq) || 1;
  return vec.map((x) => x / norm);
}

Deno.serve(async (req) => {
  try {
    const auth = isServiceCall(req);
    if (!auth.ok) {
      // fmt is a category (never the token) — safe to log, tells us who's knocking.
      console.log(`embed: rejected non-service caller (fmt=${auth.fmt})`);
      return Response.json({ ok: false, error: "Forbidden." }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}) as Record<string, unknown>);
    const text = typeof body?.text === "string" ? body.text : "";
    if (!text.trim()) {
      return Response.json({ ok: false, error: "Missing 'text'." }, { status: 400 });
    }
    if (text.length > MAX_TEXT) {
      return Response.json(
        { ok: false, error: `Text too long: ${text.length} > ${MAX_TEXT}.` },
        { status: 400 },
      );
    }
    const embedding = await embed(text);
    return Response.json({ ok: true, embedding });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
