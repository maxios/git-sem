import { expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { step } from "../support/registry.ts";
import type { World } from "../support/world.ts";

interface Artifact {
  kind: string;
  source: string;
  engine: string;
  model: string;
  prompt: string;
  tier: number;
}

interface IntentView {
  text: string;
  source: string;
  model: string;
}

interface ShowJson {
  object: string;
  intent: IntentView | null;
  artifacts: Artifact[];
}

interface LogEntry {
  commit: string;
  subject: string;
  status: "indexed" | "pending";
  intent: IntentView | null;
  paths: Array<{ path: string }>;
}

async function queued(w: World): Promise<string[]> {
  const dir = await w.semDir();
  const lines: string[] = [];
  for (const file of ["queue.processing", "queue"]) {
    const text = await readFile(join(dir, file), "utf8").catch(() => "");
    lines.push(...text.split("\n").map((l) => l.trim()).filter(Boolean));
  }
  return [...new Set(lines)];
}

function last(w: World) {
  if (!w.last) throw new Error("no command has been run yet");
  return w.last;
}

const intentsOf = (show: ShowJson) => show.artifacts.filter((a) => a.kind === "intent");

// ── commit path ─────────────────────────────────────────────────────

step("the commit succeeds", (w: World) => {
  expect(last(w).code).toBe(0);
});

step("the commit/command took less than {int} milliseconds", (w: World, limit: number) => {
  expect(last(w).ms).toBeLessThan(limit);
});

/** Poll until the check passes, for work happening in the background. */
async function eventually(what: string, check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    await Bun.sleep(50);
  }
}

step("the commit is queued for indexing", async (w: World) => {
  expect(await queued(w)).toContain(await w.revParse("HEAD"));
});

step("{int} commit(s) is/are queued for indexing", async (w: World, n: number) => {
  expect(await queued(w)).toHaveLength(n);
});

step("the queue is empty", async (w: World) => {
  expect(await queued(w)).toHaveLength(0);
});

step("the engine has not been invoked", async (w: World) => {
  expect(await w.engineCalls()).toBe(0);
});

step("the last command did not invoke the engine", (w: World) => {
  const r = last(w);
  expect(r.engineCallsAfter - r.engineCallsBefore).toBe(0);
});

step("the post-commit hook finishes in under {int} milliseconds", async (w: World, limit: number) => {
  const hook = join(w.current.dir, ".git", "hooks", "post-commit");
  const r = await w.exec(`sh "${hook}"`);
  expect(r.code).toBe(0);
  expect(r.ms).toBeLessThan(limit);
});

// ── indexing ────────────────────────────────────────────────────────

step("the last index run computed {int} file artifact(s) and reused {int}", async (w: World, computed: number, reused: number) => {
  const stats = JSON.parse(await readFile(join(await w.semDir(), "last-run.json"), "utf8")) as {
    files: { computed: number; reused: number };
  };
  expect(stats.files).toEqual({ computed, reused });
});

step("every commit on the current branch has an intent", async (w: World) => {
  const log = await w.sem<LogEntry[]>("log");
  expect(log.length).toBeGreaterThan(0);
  for (const entry of log) expect(entry.intent).not.toBeNull();
});

step("the latest commit is eventually indexed", async (w: World) => {
  await eventually("HEAD to be indexed", async () => (await w.sem<ShowJson>("show HEAD")).intent !== null);
});

step("every commit on the current branch eventually has an intent", async (w: World) => {
  await eventually("every commit to have an intent", async () => {
    const log = await w.sem<LogEntry[]>("log");
    return log.length > 0 && log.every((e) => e.intent !== null);
  });
});

step("the commit {string} eventually has an intent from model {string}", async (w: World, subject: string, model: string) => {
  const commit = await w.commitBySubject(subject);
  await eventually(`"${subject}" to have an intent from ${model}`, async () => {
    const show = await w.sem<ShowJson>(`show ${commit}`);
    return intentsOf(show).some((a) => a.model === model);
  });
});

step("git sem status eventually reports indexing progress out of {int}", async (w: World, total: number) => {
  await eventually(`status to report progress out of ${total}`, async () => {
    const status = await w.sem<{ indexing: boolean; progress: { done: number; total: number } | null }>("status");
    return status.indexing && status.progress?.total === total;
  });
});

// ── intents ─────────────────────────────────────────────────────────

step("the output contains a proposed intent", (w: World) => {
  expect(last(w).stdout).toMatch(/^Proposed intent: \S.*$/m);
});

step("no artifacts are stored", async (w: World) => {
  const r = await w.exec("git notes --ref=refs/notes/sem list");
  expect(r.stdout.trim()).toBe("");
});

step("{word} shows the authored intent {string}", async (w: World, rev: string, text: string) => {
  const show = await w.sem<ShowJson>(`show ${rev}`);
  expect(show.intent).toMatchObject({ source: "authored", text });
});

step("{word} shows an authored intent starting with {string}", async (w: World, rev: string, prefix: string) => {
  const show = await w.sem<ShowJson>(`show ${rev}`);
  expect(show.intent?.source).toBe("authored");
  expect(show.intent?.text.startsWith(prefix)).toBe(true);
});

step("{word} keeps its inferred intent as provenance", async (w: World, rev: string) => {
  const show = await w.sem<ShowJson>(`show ${rev}`);
  expect(intentsOf(show).some((a) => a.source === "inferred")).toBe(true);
});

step("{word} has {int} inferred intent(s)", async (w: World, rev: string, n: number) => {
  const show = await w.sem<ShowJson>(`show ${rev}`);
  expect(intentsOf(show).filter((a) => a.source === "inferred")).toHaveLength(n);
});

step("{word} has an inferred intent with prompt {string}", async (w: World, rev: string, prompt: string) => {
  const show = await w.sem<ShowJson>(`show ${rev}`);
  expect(intentsOf(show).some((a) => a.source === "inferred" && a.prompt === prompt)).toBe(true);
});

step("the commit {string} has an intent from model {string}", async (w: World, subject: string, model: string) => {
  const show = await w.sem<ShowJson>(`show ${await w.commitBySubject(subject)}`);
  expect(intentsOf(show).map((a) => a.model)).toContain(model);
});

step("the commit {string} has no intent from model {string}", async (w: World, subject: string, model: string) => {
  const show = await w.sem<ShowJson>(`show ${await w.commitBySubject(subject)}`);
  expect(intentsOf(show).map((a) => a.model)).not.toContain(model);
});

// ── log ─────────────────────────────────────────────────────────────

step("the log lists {int} commit(s) with intents", async (w: World, n: number) => {
  const log = await w.sem<LogEntry[]>("log");
  expect(log.filter((e) => e.intent !== null)).toHaveLength(n);
});

step("each log entry shows its touched paths", async (w: World) => {
  const log = await w.sem<LogEntry[]>("log");
  const output = last(w).stdout;
  for (const entry of log) {
    expect(entry.paths.length).toBeGreaterThan(0);
    for (const p of entry.paths) expect(output).toContain(p.path);
  }
});

step("the newest log entry is marked {string}", async (w: World, status: string) => {
  const log = await w.sem<LogEntry[]>("log");
  expect(log[0]?.status).toBe(status as LogEntry["status"]);
  expect(last(w).stdout.split("\n")[0]).toContain(status);
});

// ── provenance ──────────────────────────────────────────────────────

step("the output shows the object hash of {word}", async (w: World, rev: string) => {
  expect(last(w).stdout).toContain(await w.revParse(rev));
});

step(
  "the output shows engine {string}, model {string}, prompt {string} and tier {int}",
  (w: World, engine: string, model: string, prompt: string, tier: number) => {
    const wanted = [`engine=${engine} `, `model=${model} `, `prompt=${prompt} `, `tier=${tier} `];
    const line = last(w).stdout.split("\n").find((l) => wanted.every((part) => l.includes(part)));
    expect(line).toBeDefined();
  },
);

step("the output shows when the artifact was computed", (w: World) => {
  expect(last(w).stdout).toMatch(/at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});
