import { expect } from "bun:test";
import { spawnText } from "../../../src/proc.ts";
import { isRecomputable } from "../../../src/sharing.ts";
import type { ArtifactRecord } from "../../../src/artifacts.ts";
import { step } from "../support/registry.ts";
import type { World } from "../support/world.ts";

const SHARED = "refs/notes/sem";
const LOCAL = "refs/notes/sem-local";

/** Every record in a notes ref of a repository (a work tree or a bare remote). */
async function recordsIn(w: World, ref: string, dir: string = w.current.dir): Promise<Array<ArtifactRecord & { object: string }>> {
  const tree = await spawnText(["git", "ls-tree", "-r", ref], { cwd: dir, env: w.env });
  if (tree.code !== 0) return [];
  const blobs = tree.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(/\s+/)[2]!);
  if (blobs.length === 0) return [];
  const bodies = await spawnText(["git", "cat-file", "--batch"], { cwd: dir, env: w.env, input: `${blobs.join("\n")}\n` });
  return bodies.stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as ArtifactRecord & { object: string });
}

const kinds = (records: ArtifactRecord[]) => new Set(records.map((r) => r.kind));

step("sharing is set to {string}", async (w: World, value: string) => {
  await w.git(["config", "sem.share", value]);
});

step("the shared notes hold no recomputable records", async (w: World) => {
  expect((await recordsIn(w, SHARED)).filter(isRecomputable)).toEqual([]);
});

step("the shared notes hold only intents from model {string}", async (w: World, model: string) => {
  const records = await recordsIn(w, SHARED);
  expect(records.length).toBeGreaterThan(0);
  expect(records.map((r) => `${r.kind}:${r.model}`).filter((x) => x !== `intent:${model}`)).toEqual([]);
});

step("the local notes hold {string}, {string}, {string} and {string} records", async (w: World, a: string, b: string, c: string, d: string) => {
  const present = kinds(await recordsIn(w, LOCAL));
  for (const k of [a, b, c, d]) expect(present.has(k as ArtifactRecord["kind"])).toBe(true);
});

step("the shared notes hold {string} and {string} records", async (w: World, a: string, b: string) => {
  const present = kinds(await recordsIn(w, SHARED));
  for (const k of [a, b]) expect(present.has(k as ArtifactRecord["kind"])).toBe(true);
});

step("the shared notes also hold an {string} record from {string} for HEAD", async (w: World, kind: string, prompt: string) => {
  const head = await w.revParse("HEAD");
  const legacy = {
    v: 1,
    kind,
    object: head,
    source: "derived",
    engine: "core",
    model: "none",
    prompt,
    tier: 0,
    confidence: 1,
    value: { events: [] },
    evidence: [head],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  await w.git(["notes", "--ref", SHARED, "append", "-m", JSON.stringify(legacy), head]);
});

step("no notes hold {string} records from {string}", async (w: World, kind: string, prompt: string) => {
  const all = [...(await recordsIn(w, SHARED)), ...(await recordsIn(w, LOCAL))];
  expect(all.filter((r) => r.kind === kind && r.prompt === prompt)).toEqual([]);
});

step("no notes hold a heuristic intent for HEAD", async (w: World) => {
  const head = await w.revParse("HEAD");
  const all = [...(await recordsIn(w, SHARED)), ...(await recordsIn(w, LOCAL))];
  expect(all.filter((r) => r.object === head && r.kind === "intent" && r.engine === "heuristic")).toEqual([]);
});

step("the shared notes on {string} hold recomputable records", async (w: World, remote: string) => {
  expect((await recordsIn(w, SHARED, w.remote(remote))).filter(isRecomputable).length).toBeGreaterThan(0);
});

step("the shared notes on {string} hold no recomputable records", async (w: World, remote: string) => {
  expect((await recordsIn(w, SHARED, w.remote(remote))).filter(isRecomputable)).toEqual([]);
});

step("the shared notes on {string} hold an intent from model {string}", async (w: World, remote: string, model: string) => {
  const records = await recordsIn(w, SHARED, w.remote(remote));
  expect(records.some((r) => r.kind === "intent" && r.model === model)).toBe(true);
});

step("the shared notes have {int} commit(s) of history", async (w: World, n: number) => {
  expect((await w.git(["rev-list", "--count", SHARED, "--"])).stdout.trim()).toBe(String(n));
});

step("the shared notes on {string} are the same as mine", async (w: World, remote: string) => {
  const theirs = await spawnText(["git", "rev-parse", SHARED], { cwd: w.remote(remote), env: w.env });
  expect(theirs.stdout.trim()).toBe(await w.revParse(SHARED));
});

step("the shared notes on {string} hold an authored intent {string}", async (w: World, remote: string, text: string) => {
  const records = await recordsIn(w, SHARED, w.remote(remote));
  expect(records.some((r) => r.kind === "intent" && r.source === "authored" && (r.value as { text: string }).text === text)).toBe(true);
});

const noted = new WeakMap<World, string>();

step("I note where bob's copy of origin's notes points", async (w: World) => {
  noted.set(w, await w.revParse("refs/notes/sem-remotes/origin"));
});

step("another process holds the lock on the shared notes", async (w: World) => {
  const gitDir = (await w.git(["rev-parse", "--absolute-git-dir"])).stdout.trim();
  await Bun.write(`${gitDir}/refs/notes/sem.lock`, "");
});

step("bob's copy of origin's notes has not moved", async (w: World) => {
  expect(await w.revParse("refs/notes/sem-remotes/origin")).toBe(noted.get(w)!);
});
