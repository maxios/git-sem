import type { Tier } from "./artifacts.ts";
import type { Git } from "./git.ts";

export interface SemConfig {
  /** Run the indexer in the background after each commit. Default true. */
  autoindex: boolean;
  /** Which engine proposes intents: "heuristic" (default) or "command". */
  engine: string;
  /** Shell command for the command engine (JSON on stdin, JSON on stdout). */
  command?: string;
  /** Model identifier recorded in provenance. */
  model?: string;
  /** Prompt version recorded in provenance. */
  promptVersion?: string;
  /** Tier recorded for the command engine. Default 2. */
  tier?: Tier;
  /** Engine timeout in milliseconds. Default 120000. */
  timeoutMs: number;
  /** Tier 3 engine, used only on explicit request (e.g. `check --deep`). */
  frontier: {
    command?: string;
    model?: string;
    /** Maximum frontier calls per day; undefined means unlimited. */
    dailyBudget?: number;
  };
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return !["false", "no", "off", "0"].includes(value.toLowerCase());
}

function parseTier(value: string | undefined): Tier | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return n === 0 || n === 1 || n === 2 || n === 3 ? n : undefined;
}

function parseBudget(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Read every `sem.*` key in one git call. Keys are case-insensitive in git. */
export async function readConfig(git: Git): Promise<SemConfig> {
  const r = await git.run(["config", "--get-regexp", "^sem\\."], { allowFail: true });
  const values = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const space = line.indexOf(" ");
    const key = (space < 0 ? line : line.slice(0, space)).toLowerCase();
    values.set(key, space < 0 ? "" : line.slice(space + 1));
  }

  const timeout = Number(values.get("sem.timeout"));
  return {
    autoindex: parseBool(values.get("sem.autoindex"), true),
    engine: values.get("sem.engine") || "heuristic",
    command: values.get("sem.command") || undefined,
    model: values.get("sem.model") || undefined,
    promptVersion: values.get("sem.promptversion") || undefined,
    tier: parseTier(values.get("sem.tier")),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 120_000,
    frontier: {
      command: values.get("sem.frontier.command") || undefined,
      model: values.get("sem.frontier.model") || undefined,
      dailyBudget: parseBudget(values.get("sem.frontier.dailybudget")),
    },
  };
}
