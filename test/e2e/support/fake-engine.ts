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
  model: string;
  promptVersion: string;
  commit: string | null;
  subject: string;
  changes: Array<{ path: string }>;
}

const logFile = process.argv[2];
if (!logFile) {
  console.error("usage: fake-engine.ts <log-file>");
  process.exit(2);
}

const delayMs = Number(process.argv[3] ?? 0);
const input = JSON.parse(await Bun.stdin.text()) as Input;
if (delayMs > 0) await Bun.sleep(delayMs);
appendFileSync(logFile, `${JSON.stringify({ commit: input.commit, model: input.model, prompt: input.promptVersion })}\n`);

const subject = input.subject || "staged change";
const paths = input.changes.map((c) => c.path).join(", ");
console.log(JSON.stringify({ text: `[${input.model}] ${subject}, touching ${paths}`, confidence: 0.9 }));
