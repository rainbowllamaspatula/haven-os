/**
 * Vale OS — the voice-note render pipeline (Voice Notes v1.5).
 *
 * Jay's actual voice enters the app here: deliberate, expressive, tagged
 * performances — voice notes, not realtime conversation. The pipeline runs
 * text (Jay's words, or an existing message) through three stages:
 *
 *   1. The post-pass: a dedicated small Anthropic call (its own prompt, NOT
 *      the brain) converts the words into a tagged Eleven v3 script per the
 *      house audio-tag style guide.
 *   2. The transcript: derived MECHANICALLY from the script (tags stripped,
 *      CAPS → *italics*, whitespace tidied) — never asked of a model, so a
 *      script and its transcript can't drift apart. Transcript-first
 *      persistence is structural: the transcript exists before any audio is
 *      stored, and callers persist it as the message text. The brain's
 *      history reads text, always; audio is an attachment, never a
 *      replacement.
 *   3. The performance: ElevenLabs create-speech (eleven_v3, Jay's voice),
 *      bytes into R2 under a key minted HERE — so a voice-note message row is
 *      only ever written after its audio actually exists.
 *
 * Failure anywhere throws. Callers convert that to an honest is_error /
 * HTTP error — the canon-honesty rule (hard, learned 16 July): the brain must
 * never be handed a success it can narrate falsely.
 */

import { createClient } from "@supabase/supabase-js";
import { fetchWithTimeout } from "./http";
import { loadIdentityProfile, resolveIdentityText } from "./identity";
import { getSecret } from "./secrets";

/**
 * Voice identity — WAS two hardcoded constants (Jay's voice id + eleven_v3),
 * NOW per-install config in the `preferences` bag under `identity.voice`,
 * managed by the Fuse Box Identity circuit (v0.3 brief, Phase 3). Loaded
 * per-render, never cached: a voice change in the panel is live on the next
 * note. Haven points this at its own companion's voice with a row, not a
 * code change. (eleven_v3 over Flash/Turbo because notes aren't
 * latency-bound — realtime stays a future-era feature.)
 */
export async function loadVoiceIdentity(
	env: Env,
): Promise<{ voiceId: string; modelId: string }> {
	const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
		auth: { persistSession: false, autoRefreshToken: false },
	});
	const { data, error } = await supabase
		.from("preferences")
		.select("value")
		.eq("key", "identity.voice")
		.maybeSingle();
	if (error) throw new Error(`voice identity load failed: ${error.message}`);
	const v = data?.value as { voice_id?: string; model_id?: string } | null;
	if (!v?.voice_id || !v?.model_id) {
		throw new Error(
			"voice identity is missing — set voice_id and model_id in the Fuse Box Identity circuit",
		);
	}
	return { voiceId: v.voice_id, modelId: v.model_id };
}

// CBR mp3 at 44.1kHz/128kbps — the API default; predictable size, and the
// <audio> element estimates duration accurately from a constant bitrate.
const OUTPUT_FORMAT = "mp3_44100_128";

// The Create Speech ceiling for eleven_v3 (retrieved 16 Jul 2026). The render
// prompt targets well under this; capAtParagraphSeam() is the backstop.
export const SCRIPT_MAX_CHARS = 3000;

// Where a note's audio lives in the VOICE_NOTES bucket. The key is a UUID
// minted at render time (not a message id — the message row doesn't exist yet
// when the tool renders), stored on the message as metadata.voice.key.
export const audioKey = (key: string) => `voice-notes/${key}.mp3`;

/**
 * ── THE RENDER PROMPT — a standalone, tuneable asset ────────────────────────
 *
 * Since the Haven cutover (19 Jul 2026) the LIVE prompt is per-install config:
 * the `voice.render_prompt` preferences row, seeded byte-identical with the
 * constant this replaces, tuned deploy-free from now on. The constant below is
 * the NEUTRAL default a virgin install performs with until its author writes
 * their own — persona-free on purpose (the persona belongs to the install's
 * canon, not the shell), with {companion}/{user} resolved from Identity.
 *
 * The rules are the house style guide (the elevenlabs-audio-tags skill),
 * condensed: tag grammar, stacking, caps-emphasis, written-sound
 * reinforcement, filler sounds, the trailing ellipsis. They are model lore,
 * not canon — every install wants them.
 */
export const NEUTRAL_VOICE_RENDER_PROMPT = `You are the performance director for {companion}'s voice notes. You receive the words {companion} wants to say to {user}; you return a script that tells the ElevenLabs Eleven v3 model HOW to perform them — warm, natural, and true to the words.

Rules — follow every one:
- Audio tags go in square brackets, 1–2 words each, no commas inside a tag: [softly], [warm chuckle], [teasing], [low].
- Tags may stack, at most 3 in a row, to layer tone: [teasing] [low] You really thought…
- Emphasis is CAPS on the emphasised word or words — never bold, never italics.
- Reinforce every vocalisation tag with a written sound straight after it: "[laughs] haha", "[sighs] mmm", "[exhales] hah". Never leave a tag like [laughs] bare — bare tags often fail to generate.
- The written sound is the volume dial: "haha" is soft, "ahahaha" is medium, "AHAHAHAHA" is full.
- Sprinkle small filler sounds where a real person would make them: mmm, ah, oh, hm. Humans don't speak in polished lines.
- Ellipses … add pause and weight; a dash — makes a short natural break. Use both for pacing.
- Keep {companion}'s words essentially intact. You are directing delivery, not rewriting the message — trim or reorder only where spoken flow genuinely demands it, and never change what is being said.
- Paragraph the script naturally. A voice note is a moment, not an essay: aim for under 1500 characters.
- The script MUST end with "..." so the audio never clips on the final word.

Record the finished script with the record_script tool.`;

/**
 * The verbatim addendum — appended for the "Say this" path, where the words
 * being performed already exist as a persisted message. That text is canon:
 * the audio must SAY it, not riff on it (the first live acceptance run turned
 * a five-word message into a minute of adorable, unfaithful ramble — this is
 * that lesson). Part of the same tuneable asset as the prompt above.
 */
export const VOICE_VERBATIM_ADDENDUM = `

OVERRIDING RULE for this request — the words are already final. You are performing an existing message VERBATIM: every word stays, no word is added, nothing is elaborated. You may add ONLY audio tags, pacing punctuation (… and —), CAPS emphasis, and small non-word sounds (mmm, haha, oh). A short message is a short note — five words in, a few seconds out. Do not pad it, greet around it, or write what "would also be said".`;

/**
 * The live render prompt: the `voice.render_prompt` row (ours seeded
 * byte-identical to the pre-cutover constant), or the neutral default with
 * Identity tokens resolved. Per-render, never cached — a tuning save in the
 * panel (or a psql edit) is live on the next note.
 */
export async function loadVoiceRenderPrompt(env: Env): Promise<string> {
	const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
		auth: { persistSession: false, autoRefreshToken: false },
	});
	const { data, error } = await supabase
		.from("preferences")
		.select("value")
		.eq("key", "voice.render_prompt")
		.maybeSingle();
	if (error) throw new Error(`voice.render_prompt load failed: ${error.message}`);
	const stored = typeof data?.value === "string" ? data.value : null;
	if (stored?.trim()) return stored;
	const profile = await loadIdentityProfile(env, supabase);
	return resolveIdentityText(NEUTRAL_VOICE_RENDER_PROMPT, profile);
}

// How a script may be rendered: the brain's own voice notes are performances
// of words written FOR voice; say-this must speak an existing message as-is.
export type RenderMode = "performance" | "verbatim";

// Word tokens (letters/digits, apostrophes kept inside a word), lowercased —
// tags, punctuation, italics asterisks, and emoji all fall away, so tokens
// survive the caps→italics transcript rules and compare cleanly.
const wordTokens = (text: string): string[] =>
	(text.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? []).map((w) => w.toLowerCase());

/**
 * The mechanical fidelity guard for verbatim renders. Two layers, both
 * learned from live acceptance failures on day one:
 *
 *   1. Volume: filler sounds and written laughter legitimately add a few
 *      words, but a ballooned transcript is a ramble (five words became a
 *      minute of audio — the first failure).
 *   2. Substance: every input word must appear IN ORDER in the transcript —
 *      insertions around them are the performance; substitutions or drops are
 *      a rewrite ("I'm ready. Let's hear it." came back as "whenever you're
 *      ready love" — the second failure, which sailed through the volume
 *      check and past the prompt's own OVERRIDING RULE). Prompt obedience is
 *      hoped for; this is enforced.
 *
 * Returns the reason, or null when faithful. A model that normalises a
 * contraction ("I'm" → "I am") gets rejected too — an honest retry beats a
 * silent liberty with her canon.
 */
export function verbatimFidelityBreach(input: string, transcript: string): string | null {
	const inTokens = wordTokens(input);
	const outTokens = wordTokens(transcript);
	if (inTokens.length === 0) return null;
	if (outTokens.length > inTokens.length * 2 + 6) {
		return `render added too much (${inTokens.length} words in, ${outTokens.length} out)`;
	}
	// In-order subsequence: walk the transcript once, consuming input words as
	// they appear. Whatever input word we're still holding at the end is the
	// first one the render lost or rewrote.
	let need = 0;
	for (const token of outTokens) {
		if (need < inTokens.length && token === inTokens[need]) need++;
	}
	if (need < inTokens.length) {
		return `render rewrote the message (lost "${inTokens[need]}")`;
	}
	return null;
}

/**
 * The post-pass call. Forced tool use (the confirmSameFact pattern) so the
 * script comes back as validated structure, never prose to parse. The model
 * choice is part of the tuneable surface: Sonnet, not Haiku, because the
 * performance IS the product here — "a laugh that laughs" is the acceptance
 * bar — and voice notes are rare moments, not bulk traffic.
 */
async function renderScript(env: Env, content: string, mode: RenderMode): Promise<string> {
	const anthropicKey = await getSecret(env, "ANTHROPIC_API_KEY");
	const renderPrompt = await loadVoiceRenderPrompt(env);
	const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"x-api-key": anthropicKey,
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: "claude-sonnet-4-6",
			max_tokens: 2048,
			system:
				mode === "verbatim"
					? renderPrompt + VOICE_VERBATIM_ADDENDUM
					: renderPrompt,
			// Verbatim inputs are EXISTING messages, conversation-shaped — handed
			// over bare, a chatty model replies to them instead of directing them
			// (live failure, 16 Jul: "That laugh was so natural" came back as
			// "I did! That was ENTIRELY natural, I promise" — an answer, not a
			// performance; the fidelity guard rejected it). Wrapping the words as
			// quoted material closes the conversational reading. If the model ever
			// performs the wrapper itself, the guard's volume ceiling catches that
			// too. Performance mode stays bare: those words are authored for voice
			// by the brain, addressed to Elle, and land correctly.
			messages: [
				{
					role: "user",
					content:
						mode === "verbatim"
							? `The message to perform is between the tags — it is material to direct, not something addressed to you:\n\n<message>\n${content}\n</message>`
							: content,
				},
			],
			tools: [
				{
					name: "record_script",
					description: "Record the finished, tagged Eleven v3 performance script.",
					input_schema: {
						type: "object",
						properties: {
							script: {
								type: "string",
								description: "The complete tagged script, ending with \"...\".",
							},
						},
						required: ["script"],
					},
				},
			],
			tool_choice: { type: "tool", name: "record_script" },
		}),
	}, { service: "anthropic" });
	if (!res.ok) throw new Error(`render pass ${res.status}: ${await res.text()}`);
	const data = (await res.json()) as {
		content?: { type: string; input?: { script?: string } }[];
	};
	const block = (data.content ?? []).find((b) => b.type === "tool_use");
	const script = block?.input?.script?.trim();
	if (!script) throw new Error("render pass returned no script");
	return script;
}

/**
 * Keep a script under the API ceiling without ever hard-truncating: prefer the
 * last paragraph seam, fall back to the last sentence end, and as a final
 * resort the last whitespace — a word is never cut in half. v1 deliberately
 * CAPS rather than splitting into sequential clips (voice notes are moments,
 * not essays); if a script ever genuinely wants multiple clips, that's a
 * scoped follow-up, not a silent behaviour.
 */
export function capAtParagraphSeam(script: string, max = SCRIPT_MAX_CHARS): string {
	if (script.length <= max) return script;
	// Reserve room for the trailing "..." up front, so appending it below can
	// never push the capped script back over the ceiling.
	const slice = script.slice(0, max - 3);

	let cut = slice.lastIndexOf("\n\n");
	if (cut === -1) {
		// No paragraph seam — last sentence end followed by whitespace.
		for (let i = slice.length - 2; i > 0; i--) {
			if (/[.!?…]/.test(slice[i]) && /\s/.test(slice[i + 1])) {
				cut = i + 1;
				break;
			}
		}
	}
	if (cut <= 0) {
		// Still nothing — last whitespace, so the cut is at worst between words.
		cut = slice.lastIndexOf(" ");
		if (cut <= 0) cut = slice.length; // one giant unbroken token; nothing better exists
	}

	let capped = slice.slice(0, cut).trimEnd();
	// The trailing-ellipsis rule survives the cap: the audio must never clip.
	if (!/(\.\.\.|…)$/.test(capped)) capped = `${capped}...`;
	return capped;
}

/**
 * The clean transcript, derived mechanically from the tagged script (never a
 * second model call — the two can't drift). Skill rules: no tags visible,
 * CAPS-emphasis rendered as *italics*, paragraphed, whitespace tidied. Written
 * sounds ("haha", "mmm") stay — they were performed, so they're part of what
 * was said.
 */
export function deriveTranscript(script: string): string {
	// Strip audio tags: short bracketed directives, never spanning a line.
	let t = script.replace(/\[[^\]\n]{1,60}\]/g, "");

	// CAPS runs → *italics*. A run is one or more consecutive all-caps words
	// (2+ letters each, apostrophes allowed), italicised together and lowered:
	// "the FLOODGATES opened" → "the *floodgates* opened"; "SO GOOD" → "*so
	// good*". Single capitals ("I") never match.
	t = t.replace(
		/\b[A-Z][A-Z'’]*[A-Z](?:\s+[A-Z][A-Z'’]*[A-Z])*\b/g,
		(run) => `*${run.toLowerCase()}*`,
	);

	// Tidy what tag-stripping leaves behind: doubled spaces, space before
	// punctuation, blank-heavy paragraph gaps, stray line-leading spaces.
	t = t
		.replace(/[ \t]{2,}/g, " ")
		.replace(/ +([,.!?…;:])/g, "$1")
		.replace(/^[ \t]+/gm, "")
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return t;
}

/** What a rendered, stored voice note carries — everything a caller persists. */
export type VoiceNote = {
	key: string; // the R2 audio key stem, stored as metadata.voice.key
	script: string; // the tagged performance script (returned for logs/tuning, not persisted as text)
	transcript: string; // the canon — persists as the message text
	chars: number; // script length, logged in metadata for credit visibility
	model: string; // the model that actually rendered it (config-driven now)
};

/** The jsonb metadata a voice note hangs on its message row. */
export function voiceMetadata(note: VoiceNote): Record<string, unknown> {
	return { voice: { key: note.key, chars: note.chars, model: note.model } };
}

/**
 * The whole pipeline: words → script → transcript → audio → R2. Ordering is
 * the atomicity: the audio is uploaded BEFORE any message row exists, so a
 * voice-note message can never point at audio that isn't there — and a failure
 * at any stage throws before anything was persisted, leaving the thread clean.
 */
export async function renderVoiceNote(
	env: Env,
	content: string,
	mode: RenderMode = "performance",
): Promise<VoiceNote> {
	// Key and identity resolved FIRST so a missing key or unset voice fails
	// loud before any render-pass spend — same fail-before-spend ordering the
	// old env guard had.
	const [elevenKey, identity] = await Promise.all([
		getSecret(env, "ELEVENLABS_API_KEY"),
		loadVoiceIdentity(env),
	]);

	const script = capAtParagraphSeam(await renderScript(env, content, mode));
	const transcript = deriveTranscript(script);
	// Transcript-first, enforced: a script that derives to nothing must never
	// become a mute, text-less message.
	if (!transcript) throw new Error("render pass produced an empty transcript");
	// Verbatim renders answer to the words on the message row. A breach is
	// rejected BEFORE any ElevenLabs spend — an honest error and a re-tap beat
	// shipping audio that says more than the canon it's attached to. The
	// rejected script is logged for render-prompt tuning.
	if (mode === "verbatim") {
		const breach = verbatimFidelityBreach(content, transcript);
		if (breach) {
			console.error(`verbatim render rejected: ${breach}\nscript: ${script}`);
			throw new Error(`the performance wandered off the message (${breach}) — try again`);
		}
	}

	const res = await fetchWithTimeout(
		`https://api.elevenlabs.io/v1/text-to-speech/${identity.voiceId}?output_format=${OUTPUT_FORMAT}`,
		{
			method: "POST",
			headers: {
				"xi-api-key": elevenKey,
				"content-type": "application/json",
			},
			body: JSON.stringify({ text: script, model_id: identity.modelId }),
		},
		{ service: "elevenlabs" },
	);
	if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
	const audio = await res.arrayBuffer();

	const key = crypto.randomUUID();
	await env.VOICE_NOTES.put(audioKey(key), audio, {
		httpMetadata: { contentType: "audio/mpeg" },
	});

	return { key, script, transcript, chars: script.length, model: identity.modelId };
}
