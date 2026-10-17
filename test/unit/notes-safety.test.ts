/**
 * Data-safety tests for notes rewrites (prune, push, reset). Each one is a
 * reproduction of a way a record that cannot be recomputed could be lost.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { now, type ArtifactRecord } from "../../src/artifacts.ts";

const lineOf = (r: ArtifactRecord) => JSON.stringify(r);
import { CatFile, NotesBatch } from "../../src/batch.ts";
import { Git } from "../../src/git.ts";
import { applyPolicy } from "../../src/prune.ts";
import { DEFAULT_POLICY } from "../../src/sharing.ts";
import { ArtifactStore, LOCAL_NOTES_REF, NOTES_REF } from "../../src/store.ts";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x", GIT_CONFIG_NOSYSTEM: "1" };
Object.assign(process.env, ENV);

let dir: string;
let git: Git;
let head: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "git-sem-safety-"));
  git = new Git(dir);
  await git.run(["init", "-q", "-b", "main"]);
  await git.run(["commit", "-q", "--allow-empty", "-m", "one"]);
  head = await git.out(["rev-parse", "HEAD"]);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function rec(over: Partial<ArtifactRecord>): ArtifactRecord {
  return {
    v: 1,
    kind: "intent",
    object: head,
    source: "inferred",
    engine: "command",
    model: "m1",
    prompt: "intent/v1",
    tier: 2,
    confidence: 0.9,
    value: { text: "x" },
    evidence: [head],
    createdAt: now(),
    ...over,
  };
}

const derived = () => rec({ kind: "changes", source: "derived", engine: "core", model: "none", prompt: "changes/v1", tier: 0, value: { parents: [], subject: "one", paths: [] } });
const heuristic = () => rec({ engine: "heuristic", model: "none", prompt: "heuristic/v1", tier: 0, value: { text: "one" } });

/** Write a note exactly as given, the way git-sem 0.2 stored everything in the shared ref. */
async function seed(ref: string, lines: string[]): Promise<void> {
  const file = join(dir, "note.txt");
  await writeFile(file, `${lines.join("\n")}\n`);
  await git.run(["notes", "--ref", ref, "add", "-f", "-F", file, head]);
}

async function linesIn(ref: string): Promise<string[]> {
  const r = await git.run(["notes", "--ref", ref, "show", head], { allowFail: true });
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

describe("prune never loses judgment", () => {
  test("an intent written while a note is being emptied survives (review #2)", async () => {
    await seed(NOTES_REF, [lineOf(derived())]);
    const cat = new CatFile(dir);
    const batch = await NotesBatch.open(git, NOTES_REF, cat);
    batch.edit(head, { add: [], remove: await batch.lines(head) }); // the note would become empty

    const authored = rec({ source: "authored", engine: "human", model: "none", prompt: "none", author: "k@x", value: { text: "mine" } });
    await new ArtifactStore(git, DEFAULT_POLICY).add(head, [authored]); // a concurrent writer

    await batch.close();
    await cat.close();
    expect(await linesIn(NOTES_REF)).toContain(lineOf(authored));
  });

  test("two teammates' intents from the same model both survive a rewrite (review #3)", async () => {
    const alice = rec({ value: { text: "alice's model intent" }, createdAt: "2026-10-01T00:00:00.000Z" });
    const bob = rec({ value: { text: "bob's model intent" }, createdAt: "2026-10-02T00:00:00.000Z" });
    await seed(NOTES_REF, [lineOf(alice), lineOf(bob), lineOf(heuristic()), lineOf(derived())]);

    await applyPolicy(git, DEFAULT_POLICY, { scope: "all" });

    const shared = await linesIn(NOTES_REF);
    expect(shared).toContain(lineOf(alice));
    expect(shared).toContain(lineOf(bob));
    expect(shared).toHaveLength(2); // heuristic dropped, derived moved
    expect(await linesIn(LOCAL_NOTES_REF)).toHaveLength(1);
  });

  test("lines from a newer git-sem are kept as they are", async () => {
    const future = JSON.stringify({ v: 2, kind: "something-new", object: head });
    await seed(NOTES_REF, [future, lineOf(derived())]);
    await applyPolicy(git, DEFAULT_POLICY, { scope: "all" });
    expect(await linesIn(NOTES_REF)).toEqual([future]);
  });

  test("adding a record keeps every existing line, even ones that share a key", async () => {
    const a = rec({ value: { text: "a" }, createdAt: "2026-10-01T00:00:00.000Z" });
    const b = rec({ value: { text: "b" }, createdAt: "2026-10-02T00:00:00.000Z" });
    await seed(NOTES_REF, [lineOf(a), lineOf(b)]);
    await new ArtifactStore(git, DEFAULT_POLICY).add(head, [rec({ model: "m2" })]);
    const shared = await linesIn(NOTES_REF);
    expect(shared).toContain(lineOf(a));
    expect(shared).toContain(lineOf(b));
    expect(shared).toHaveLength(3);
  });
});

describe("concurrent writers (second review)", () => {
  test("bulk and single-record writers on one note never overwrite each other", async () => {
    const N = 25;
    const agents = Array.from({ length: N }, (_, i) => rec({ engine: "agent", model: `bot-${i}`, prompt: "agent/v1" }));
    const people = Array.from({ length: N }, (_, i) =>
      rec({ source: "authored", engine: "human", model: "none", prompt: "none", author: `p${i}@x`, createdAt: `2026-10-0${1 + (i % 9)}T00:00:${String(i).padStart(2, "0")}.000Z` }),
    );
    // Separate processes, like the background indexer and a person at the terminal.
    const script = (kind: "batch" | "store", records: ArtifactRecord[]) => `
      const { Git } = await import(${JSON.stringify(join(import.meta.dir, "../../src/git.ts"))});
      const { NotesBatch } = await import(${JSON.stringify(join(import.meta.dir, "../../src/batch.ts"))});
      const { ArtifactStore } = await import(${JSON.stringify(join(import.meta.dir, "../../src/store.ts"))});
      const git = new Git(${JSON.stringify(dir)});
      for (const r of ${JSON.stringify(records)}) {
        if (${JSON.stringify(kind)} === "batch") { const b = await NotesBatch.open(git); await b.add(r.object, [r]); await b.close(); }
        else await new ArtifactStore(git, { shareDerived: false }).add(r.object, [r]);
      }`;
    const run = (code: string) => Bun.spawn([process.execPath, "-e", code], { cwd: dir, env: { ...process.env }, stdout: "ignore", stderr: "pipe" });
    const procs = [run(script("batch", agents)), run(script("store", people))];
    const codes = await Promise.all(procs.map((p) => p.exited));
    const errors = await Promise.all(procs.map((p) => new Response(p.stderr).text()));
    expect({ codes, errors: errors.filter(Boolean) }).toEqual({ codes: [0, 0], errors: [] });

    const lines = await linesIn(NOTES_REF);
    const missing = [...agents, ...people].filter((r) => !lines.includes(lineOf(r)));
    expect(missing.map((r) => r.model === "none" ? r.author : r.model)).toEqual([]);
  }, 60_000);
});
