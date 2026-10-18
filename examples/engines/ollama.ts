#!/usr/bin/env bun
/**
 * Example command engine backed by a local Ollama model. It answers every
 * task git-sem sends (protocol 1):
 *
 *   intent          why a commit or staged change was made
 *   summarize       one intent for a whole branch (git sem intent --branch)
 *   resolve         a proposed resolution for a conflicted file (git sem resolve)
 *   contradictions  a review of two sides of a merge (git sem check --deep)
 *
 * As the intent engine:
 *
 *   git config sem.engine command
 *   git config sem.command "bun /path/to/git-sem/examples/engines/ollama.ts"
 *   git config sem.model "llama3.2:3b"
 *   git config sem.tier 2
 *
 * As the Tier 3 engine for `check --deep`:
 *
 *   git config sem.frontier.command "bun /path/to/git-sem/examples/engines/ollama.ts"
 *   git config sem.frontier.model "qwen2.5:14b"
 *
 * Reads one JSON request on stdin and prints
 * {"text": "...", "confidence": 0..1, "questions": [...]} on stdout.
 * Set OLLAMA_HOST to use a server other than http://localhost:11434.
 */

type Change = { status: string; path: string; from?: string };

export type Request =
  | {
      task: "intent";
      model: string;
      subject: string;
      body: string;
      changes: Change[];
      diff: string;
      history?: Array<{ commit: string; intent: string | null; subject: string }>;
      reversals?: Array<{ commit: string; path: string; intent: string | null }>;
    }
  | { task: "summarize"; model: string; subject: string; intents: string[] }
  | {
      task: "resolve";
      model: string;
      path: string;
      base: string | null;
      ours: string;
      theirs: string;
      oursIntents?: string[];
      theirsIntents?: string[];
    }
  | { task: "contradictions"; model: string; a: { ref: string; intents: string[] }; b: { ref: string; intents: string[] }; warnings: string[] };

export interface Prompt {
  prompt: string;
  /** Tokens of context to ask Ollama for. */
  numCtx: number;
  /** Keep the answer's text exactly as returned (file contents). */
  exact: boolean;
}

export class RequestError extends Error {}

const DIFF_LIMIT = 6_000;
/** Above this, a conflicted file cannot fit in the context window with room to answer. */
export const RESOLVE_LIMIT = 24_000;

const list = (items: string[], empty = "(none)") => (items.length ? items.map((i) => `- ${i.split("\n")[0]}`).join("\n") : empty);

const ANSWER = `Respond with JSON only: {"text": string, "confidence": number between 0 and 1, "questions": string[]}.`;

export function promptFor(req: Request): Prompt {
  switch (req.task) {
    case "intent": {
      const files = req.changes.map((c) => `${c.status} ${c.from ? `${c.from} -> ` : ""}${c.path}`).join("\n");
      const history = list((req.history ?? []).slice(0, 10).map((h) => `${h.commit.slice(0, 7)}: ${h.intent ?? h.subject}`));
      const reversals = list(
        (req.reversals ?? []).map((r) => `restores ${r.path} to before ${r.commit.slice(0, 7)} (${r.intent ?? "intent unknown"})`),
      );
      return {
        numCtx: 8192,
        exact: false,
        prompt: `You describe the intent of a code change: why it was made, not what lines changed.
Answer in one sentence of at most 20 words. Use the project history for context and vocabulary.
Never invent a reason: if the change and history do not show why, describe what changed, set a low
confidence and ask the author a short question instead.
${ANSWER}

Recorded intents of earlier commits touching these files:
${history}

Exact reversals of earlier commits:
${reversals}

Commit subject: ${req.subject || "(none)"}
Commit body: ${req.body || "(none)"}
Files:
${files}

Diff:
${req.diff.slice(0, DIFF_LIMIT)}

Respond with the JSON object only.`,
      };
    }

    case "summarize":
      return {
        numCtx: 8192,
        exact: false,
        prompt: `You summarize what a branch of commits is for, from the intents recorded for its commits.
Answer in one sentence of at most 25 words. Say what the branch achieves as a whole, not a list of commits.
Use only what the intents say; if they are too vague to tell, say so, set a low confidence and ask a question.
${ANSWER}

Branch: ${req.subject}
Intents, oldest first:
${list(req.intents)}

Respond with the JSON object only.`,
      };

    case "resolve": {
      const size = (req.base?.length ?? 0) + req.ours.length + req.theirs.length;
      if (size > RESOLVE_LIMIT) {
        throw new RequestError(
          `${req.path} is too large to resolve with this engine (${size} characters across base, ours and theirs; limit ${RESOLVE_LIMIT})`,
        );
      }
      return {
        // Three versions in, one whole file out.
        numCtx: 16384,
        exact: true,
        prompt: `You resolve a merge conflict in one file. Combine both sides so that each side's change is kept,
unless they contradict each other. Return the COMPLETE resolved file in "text", exactly as it should be
written to disk: no conflict markers, no explanations, no code fences. If the two sides truly contradict
each other, keep "ours", set a confidence below 0.5 and say in "questions" what the author must decide.
${ANSWER}

File: ${req.path}
Why ours changed it:
${list(req.oursIntents ?? [])}
Why theirs changed it:
${list(req.theirsIntents ?? [])}

=== BASE (common ancestor) ===
${req.base ?? "(the file did not exist)"}
=== OURS ===
${req.ours}
=== THEIRS ===
${req.theirs}
=== END ===

Respond with the JSON object only.`,
      };
    }

    case "contradictions":
      return {
        numCtx: 8192,
        exact: false,
        prompt: `You review two branches before they are merged. Find assumptions that contradict each other:
both sides owning the same thing, one side relying on something the other removes or changes,
incompatible conventions. Ignore changes that merely touch the same area. Report in 1 to 3 sentences.
If you find no contradiction, say so plainly. Put anything the authors must decide in "questions".
${ANSWER}

Branch ${req.a.ref}, intents:
${list(req.a.intents)}

Branch ${req.b.ref}, intents:
${list(req.b.intents)}

Already flagged by git-sem's own checks:
${list(req.warnings)}

Respond with the JSON object only.`,
      };

    default:
      throw new RequestError(`unsupported task: ${(req as { task?: unknown }).task}`);
  }
}

// A JSON schema in `format` constrains decoding, so even a small model can only
// answer in this shape.
const SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    questions: { type: "array", items: { type: "string" } },
  },
  required: ["text", "confidence"],
};

export async function answer(req: Request, host: string): Promise<{ text: string; confidence: number; questions: string[] }> {
  const p = promptFor(req);
  const response = await fetch(`${host}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: req.model,
      prompt: p.prompt,
      stream: false,
      format: SCHEMA,
      options: { num_ctx: p.numCtx, temperature: p.exact ? 0 : 0.2 },
    }),
  });
  if (!response.ok) throw new Error(`ollama returned ${response.status}: ${await response.text()}`);

  const { response: raw } = (await response.json()) as { response: string };
  const parsed = JSON.parse(raw) as { text?: unknown; confidence?: unknown; questions?: unknown };
  if (typeof parsed.text !== "string" || parsed.text.trim() === "") throw new Error(`model returned no text: ${raw}`);
  if (p.exact && /^(<<<<<<<|=======|>>>>>>>)( |$)/m.test(parsed.text)) {
    throw new Error("model returned a resolution that still has conflict markers");
  }
  return {
    text: p.exact ? parsed.text : parsed.text.trim(),
    confidence: typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
    questions: Array.isArray(parsed.questions) ? parsed.questions.filter((q): q is string => typeof q === "string") : [],
  };
}

if (import.meta.main) {
  try {
    const req = (await Bun.stdin.json()) as Request;
    const result = await answer(req, process.env.OLLAMA_HOST ?? "http://localhost:11434");
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(e instanceof RequestError ? 2 : 1);
  }
}
