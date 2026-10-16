import type { Tier } from "../artifacts.ts";
import { clampConfidence } from "../artifacts.ts";
import { spawnText } from "../proc.ts";
import type { Engine, EngineInput, IntentProposal } from "./types.ts";

export class EngineError extends Error {
  override name = "EngineError";
}

export interface CommandEngineOptions {
  id?: string;
  command: string;
  model: string;
  promptVersion: string;
  tier: Tier;
  cwd: string;
  timeoutMs: number;
}

/**
 * Plug any model in through a process boundary: the command receives one of
 * the protocol inputs as JSON on stdin (see `task`) and prints
 * `{"text": "...", "confidence": 0..1, "questions": [...]}`.
 * This keeps the core free of model SDKs; local models, APIs and test doubles
 * all look the same from here.
 */
export function commandEngine(opts: CommandEngineOptions): Engine {
  async function call(input: EngineInput): Promise<IntentProposal> {
    const r = await spawnText(["sh", "-c", opts.command], {
      cwd: opts.cwd,
      input: JSON.stringify(input),
      timeoutMs: opts.timeoutMs,
    });
    if (r.timedOut) throw new EngineError(`engine timed out after ${opts.timeoutMs}ms`);
    if (r.code !== 0) throw new EngineError(`engine exited ${r.code}: ${r.stderr.trim()}`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(r.stdout.trim().split("\n").pop() ?? "");
    } catch {
      throw new EngineError(`engine printed invalid JSON: ${r.stdout.slice(0, 200)}`);
    }
    const out = parsed as { text?: unknown; confidence?: unknown; questions?: unknown };
    if (typeof out.text !== "string" || out.text.trim() === "") {
      throw new EngineError("engine response is missing a non-empty `text`");
    }
    const questions = Array.isArray(out.questions)
      ? out.questions.filter((q): q is string => typeof q === "string" && q.trim() !== "").map((q) => q.trim())
      : undefined;
    // Resolutions are file contents: keep them exact. Everything else is prose.
    const text = input.task === "resolve" ? out.text : out.text.trim();
    return { text, confidence: clampConfidence(out.confidence), questions };
  }

  return {
    id: opts.id ?? "command",
    model: opts.model,
    promptVersion: opts.promptVersion,
    tier: opts.tier,
    wantsDiff: true,
    proposeIntent: call,
    summarize: call,
    resolveConflict: call,
    findContradictions: call,
  };
}
