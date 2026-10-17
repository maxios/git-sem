import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { step } from "../support/registry.ts";
import type { World } from "../support/world.ts";
import { fn } from "./entities.ts";

interface SearchJson {
  source: string;
  index: string;
  results: Array<{ kind: string; name: string | null; commit: string; branches: string[]; reach: string; score: number }>;
}

/** Re-run the last search command with --json to inspect its structured results. */
async function lastSearch(w: World): Promise<SearchJson> {
  const command = w.last?.command ?? "";
  if (!command.startsWith("git sem search")) throw new Error("the last command was not a search");
  return JSON.parse((await w.must(`${command} --json`)).stdout) as SearchJson;
}

step("branch {string} adds {string} with a function {string}", async (w: World, branch: string, path: string, name: string) => {
  await w.git(["checkout", "--quiet", "-b", branch]);
  const full = join(w.current.dir, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, fn(name));
  w.functions.set(name, path);
  await w.git(["add", "-A"]);
  await w.git(["commit", "--quiet", "-m", `Add ${name}`]);
  await w.git(["checkout", "--quiet", "main"]);
});

step("a branch named {string} exists", async (w: World, branch: string) => {
  await w.git(["branch", branch]);
});

step("I delete the branch {string}", async (w: World, branch: string) => {
  await w.git(["branch", "--quiet", "-D", branch]);
});

step("the repository has no remotes", async (w: World) => {
  expect((await w.git(["remote"])).stdout.trim()).toBe("");
});

step("the local index is deleted", async (w: World) => {
  const path = join(await w.semDir(), "index.sqlite");
  expect(existsSync(path)).toBe(true);
  await rm(path);
});

step("the local index exists again", async (w: World) => {
  expect(existsSync(join(await w.semDir(), "index.sqlite"))).toBe(true);
});

step("the results come from the local index", async (w: World) => {
  const json = await lastSearch(w);
  expect(json.source).toBe("local-index");
  expect(json.index).toBe(join(await w.semDir(), "index.sqlite"));
  expect(existsSync(json.index)).toBe(true);
});

step("the top search result is the entity {string} on branch {string}", async (w: World, name: string, branch: string) => {
  const [top] = (await lastSearch(w)).results;
  expect(top).toMatchObject({ kind: "entity", name });
  expect(top?.branches).toContain(branch);
});

step("the top search result is the commit {string}", async (w: World, subject: string) => {
  const [top] = (await lastSearch(w)).results;
  expect(top).toMatchObject({ kind: "commit", commit: await w.commitBySubject(subject) });
});

step("each search result shows its commit, branch and similarity", (w: World) => {
  const lines = (w.last?.stdout ?? "").split("\n").filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(line).toMatch(/^\d\.\d\d  .+ @ [0-9a-f]{7}  \[.+\]$/);
});

step("the search results do not include {string}", async (w: World, name: string) => {
  expect((await lastSearch(w)).results.map((r) => r.name)).not.toContain(name);
});

step("the search results include {string} labeled {string}", async (w: World, name: string, labelText: string) => {
  const hit = (await lastSearch(w)).results.find((r) => r.name === name);
  expect(hit).toBeDefined();
  const line = (w.last?.stdout ?? "").split("\n").find((l) => l.includes(` ${name} `));
  expect(line).toContain(labelText);
});

step("the semantic engine paraphrases commits as:", async (w: World, rows: string[][]) => {
  const map = Object.fromEntries(rows.slice(1).map(([prefix, intent]) => [prefix!, intent!]));
  const stub = join(w.root, "paraphrase-engine.ts");
  await writeFile(
    stub,
    `const map = ${JSON.stringify(map)};
const input = await Bun.stdin.json();
const key = Object.keys(map).find((k) => (input.subject ?? "").startsWith(k));
console.log(JSON.stringify({ text: key ? map[key] : "A change.", confidence: 0.9 }));
`,
  );
  await w.git(["config", "sem.engine", "command"]);
  await w.git(["config", "sem.command", `"${process.execPath}" "${stub}"`]);
  await w.git(["config", "sem.model", "paraphraser"]);
});
