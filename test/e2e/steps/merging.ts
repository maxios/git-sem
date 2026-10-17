import { expect } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { step } from "../support/registry.ts";
import type { World } from "../support/world.ts";
import { fn } from "./entities.ts";

/** Make a commit on a branch (created from main if needed), then return to main. */
async function onBranch(w: World, branch: string, message: string, change: () => Promise<void>): Promise<void> {
  const exists = (await w.exec(`git rev-parse --verify --quiet refs/heads/${branch}`)).code === 0;
  await w.git(exists ? ["checkout", "--quiet", branch] : ["checkout", "--quiet", "-b", branch, "main"]);
  await change();
  await w.git(["add", "-A"]);
  await w.git(["commit", "--quiet", "-m", message]);
  await w.git(["checkout", "--quiet", "main"]);
}

async function write(w: World, path: string, content: string): Promise<void> {
  const full = join(w.current.dir, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}

async function edit(w: World, path: string, f: (s: string) => string): Promise<void> {
  const full = join(w.current.dir, path);
  await writeFile(full, f(await readFile(full, "utf8")));
}

function pathOf(w: World, name: string): string {
  const path = w.functions.get(name);
  if (!path) throw new Error(`no function "${name}" was created by a step`);
  return path;
}

// ── shaping branches ────────────────────────────────────────────────

step("on branch {string} I change the function {string} with message {string}", async (w: World, branch: string, name: string, message: string) => {
  await onBranch(w, branch, message, () =>
    edit(w, pathOf(w, name), (s) => s.replace("  const row = db.users.find(id);", `  const row = db.users.find(id);\n  audit(${JSON.stringify(message)});`)),
  );
});

step("on branch {string} I commit {string} with content {string}", async (w: World, branch: string, path: string, content: string) => {
  await onBranch(w, branch, `Set ${path} to ${content}`, () => write(w, path, `${content}\n`));
});

step("on branch {string} I commit {string} with a function {string} and message {string}", async (w: World, branch: string, path: string, name: string, message: string) => {
  await onBranch(w, branch, message, () => write(w, path, fn(name)));
});

step("on branch {string} I commit {string} containing:", async (w: World, branch: string, path: string, content: string) => {
  await onBranch(w, branch, `Add ${path}`, () => write(w, path, `${content}\n`));
});

step("on branch {string} I rename the function {string} to {string} in place", async (w: World, branch: string, from: string, to: string) => {
  await onBranch(w, branch, `Rename ${from} to ${to}`, () => edit(w, pathOf(w, from), (s) => s.replace(`function ${from}(`, `function ${to}(`)));
});

step("on branch {string} I commit {string} calling {string} with message {string}", async (w: World, branch: string, path: string, callee: string, message: string) => {
  const content = `import { ${callee} } from "./user";\n\nexport function showProfile(id: string) {\n  return ${callee}(id);\n}\n`;
  await onBranch(w, branch, message, () => write(w, path, content));
});

step("I merge branch {string} into {string} with conflicts", async (w: World, from: string, into: string) => {
  await w.git(["checkout", "--quiet", into]);
  const r = await w.exec(`git merge --no-edit ${from}`);
  expect(r.code).not.toBe(0);
  expect((await w.git(["ls-files", "-u"])).stdout.trim()).not.toBe("");
});

step("I merge branch {string} into {string}", async (w: World, from: string, into: string) => {
  await w.git(["checkout", "--quiet", into]);
  await w.record(`git merge ${from}`, () => w.exec(`git merge --quiet --no-edit --no-ff ${from}`));
});

// ── outcomes ────────────────────────────────────────────────────────

step("the merge completes", async (w: World) => {
  expect(w.last?.code).toBe(0);
  const parents = (await w.git(["log", "-1", "--format=%P"])).stdout.trim().split(" ");
  expect(parents).toHaveLength(2);
});

step("{string} still contains conflict markers", async (w: World, path: string) => {
  expect(await readFile(join(w.current.dir, path), "utf8")).toMatch(/^<<<<<<< /m);
});

step("{string} contains {string} and {string} without conflict markers", async (w: World, path: string, a: string, b: string) => {
  const text = await readFile(join(w.current.dir, path), "utf8");
  expect(text).toContain(a);
  expect(text).toContain(b);
  expect(text).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
});

step("{string} is not staged", async (w: World, path: string) => {
  expect((await w.git(["ls-files", "-u", "--", path])).stdout.trim()).not.toBe("");
});

interface MergeView {
  entities: Array<{
    name: string;
    redundant: boolean;
    a: Array<{ intent: string | null }>;
    b: Array<{ intent: string | null }>;
  }>;
}

async function lastMergeView(w: World): Promise<MergeView> {
  const command = w.last?.command ?? "";
  if (!command.startsWith("git sem merge-view")) throw new Error("the last command was not merge-view");
  return JSON.parse((await w.must(`${command} --json`)).stdout) as MergeView;
}

step("the merge view lists exactly the entities {string} and {string}", async (w: World, x: string, y: string) => {
  const { entities } = await lastMergeView(w);
  expect(entities.map((e) => e.name).sort()).toEqual([x, y].sort());
});

step("each listed entity shows the intent from {string} and the intent from {string}", async (w: World, a: string, b: string) => {
  const { entities } = await lastMergeView(w);
  const out = w.last?.stdout ?? "";
  for (const e of entities) {
    expect(e.a.some((t) => t.intent)).toBe(true);
    expect(e.b.some((t) => t.intent)).toBe(true);
  }
  expect(out).toMatch(new RegExp(`^  ${a}\\s+[0-9a-f]{7}  `, "m"));
  expect(out).toMatch(new RegExp(`^  ${b}\\s+[0-9a-f]{7}  `, "m"));
});

step("the merge view flags {string} as likely redundant", async (w: World, name: string) => {
  const { entities } = await lastMergeView(w);
  expect(entities.find((e) => e.name === name)?.redundant).toBe(true);
  expect(w.last?.stdout).toMatch(new RegExp(`^${name}\\s+likely redundant`, "m"));
});

step("the warning cites the commits {string} and {string}", async (w: World, a: string, b: string) => {
  const out = w.last?.stdout ?? "";
  for (const subject of [a, b]) {
    const out2 = await w.exec(`git log --all --format=%H%x09%s`);
    const hash = out2.stdout.split("\n").find((l) => l.split("\t")[1] === subject)?.split("\t")[0];
    expect(hash).toBeDefined();
    expect(out).toContain(hash!.slice(0, 7));
  }
});

step("the merge commit records that it was merged despite {int} warning(s)", async (w: World, n: number) => {
  const show = JSON.parse((await w.must("git sem show HEAD --json")).stdout) as {
    artifacts: Array<{ kind: string; value: { outcome: string; warnings: unknown[] } }>;
  };
  const decision = show.artifacts.find((a) => a.kind === "decision");
  expect(decision?.value.outcome).toBe("merged");
  expect(decision?.value.warnings).toHaveLength(n);
});

step("I commit {string} containing:", async (w: World, path: string, content: string) => {
  await write(w, path, `${content}\n`);
  await w.git(["add", "-A"]);
  await w.git(["commit", "--quiet", "-m", `Update ${path}`]);
});

step("I move {string} to {string} replacing {string} with {string}", async (w: World, from: string, to: string, a: string, b: string) => {
  const text = await readFile(join(w.current.dir, from), "utf8");
  await w.git(["rm", "--quiet", from]);
  await write(w, to, text.replace(a, b));
  await w.git(["add", "-A"]);
  await w.git(["commit", "--quiet", "-m", `Move ${from} to ${to}`]);
});
