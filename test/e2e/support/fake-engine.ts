/**
 * A deterministic stand-in for a model, speaking the command-engine protocol.
 * Every invocation is appended to the log file passed as the first argument,
 * so tests can assert exactly when inference did (and did not) happen.
 *
 *   usage: bun fake-engine.ts <log-file> [delay-ms]
 *
 * The optional delay simulates a slow model.
 */
import { appendFileSync } from "node:fs";

interface Input {
  task: "intent" | "summarize" | "resolve" | "contradictions";
  model: string;
  promptVersion: string;
  commit?: string | null;
  subject?: string;
  changes?: Array<{ path: string }>;
  history?: Array<{ intent: string | null }>;
  intents?: string[];
  ours?: string;
  theirs?: string;
  warnings?: string[];
}

const logFile = process.argv[2];
if (!logFile) {
  console.error("usage: fake-engine.ts <log-file>");
  process.exit(2);
}

const delayMs = Number(process.argv[3] ?? 0);
const input = JSON.parse(await Bun.stdin.text()) as Input;
if (delayMs > 0) await Bun.sleep(delayMs);
const history = (input.history ?? []).map((h) => h.intent).filter((t): t is string => t !== null);
appendFileSync(
  logFile,
  `${JSON.stringify({ task: input.task, commit: input.commit ?? null, model: input.model, prompt: input.promptVersion, history })}\n`,
);

function reply(text: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ text, confidence: 0.9, ...extra }));
}

switch (input.task) {
  case "summarize":
    reply(`[${input.model}] summary of ${input.intents?.length ?? 0} intents`);
    break;
  case "resolve": {
    // Keep every line from both sides, ours first: a visible, checkable merge.
    const lines = (input.ours ?? "").split("\n").filter(Boolean);
    for (const l of (input.theirs ?? "").split("\n").filter(Boolean)) if (!lines.includes(l)) lines.push(l);
    reply(`${lines.join("\n")}\n`);
    break;
  }
  case "contradictions":
    reply(`[${input.model}] reviewed ${input.warnings?.length ?? 0} warnings`, { questions: ["Which module should own sessions?"] });
    break;
  default: {
    const subject = input.subject || "staged change";
    const paths = (input.changes ?? []).map((c) => c.path).join(", ");
    reply(`[${input.model}] ${subject}, touching ${paths}`);
  }
}
