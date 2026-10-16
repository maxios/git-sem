#!/usr/bin/env bun
/**
 * Example command engine backed by a local Ollama model.
 *
 *   git config sem.engine command
 *   git config sem.command "bun /path/to/git-sem/examples/engines/ollama.ts"
 *   git config sem.model "llama3.2:3b"
 *   git config sem.tier 2
 *
 * Reads the git-sem IntentInput (protocol 1) on stdin and prints
 * {"text": "...", "confidence": 0..1} on stdout. Set OLLAMA_HOST to use a
 * server other than http://localhost:11434.
 */

export {};

interface IntentInput {
  model: string;
  subject: string;
  body: string;
  changes: Array<{ status: string; path: string; from?: string }>;
  diff: string;
}

const input = (await Bun.stdin.json()) as IntentInput;
const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";

const files = input.changes.map((c) => `${c.status} ${c.from ? `${c.from} -> ` : ""}${c.path}`).join("\n");
const instruction = `You describe the intent of a code change: why it was made, not what lines changed.
Answer in one sentence of at most 20 words. If the change gives no evidence of intent, say so.
Respond with JSON only: {"text": string, "confidence": number between 0 and 1}.

Commit subject: ${input.subject || "(none)"}
Commit body: ${input.body || "(none)"}
Files:
${files}

Diff:
${input.diff.slice(0, 12_000)}`;

const response = await fetch(`${host}/api/generate`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: input.model, prompt: instruction, stream: false, format: "json" }),
});
if (!response.ok) {
  console.error(`ollama returned ${response.status}: ${await response.text()}`);
  process.exit(1);
}

const { response: raw } = (await response.json()) as { response: string };
const parsed = JSON.parse(raw) as { text?: unknown; confidence?: unknown };
if (typeof parsed.text !== "string" || parsed.text.trim() === "") {
  console.error(`model returned no text: ${raw}`);
  process.exit(1);
}
const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;
console.log(JSON.stringify({ text: parsed.text.trim(), confidence }));
