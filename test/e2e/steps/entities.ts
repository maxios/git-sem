import { expect } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { step } from "../support/registry.ts";
import type { World } from "../support/world.ts";

/** A small, realistic function body. Same body, different name, is a pure rename. */
export function fn(name: string, returns = "row ? row.name : null"): string {
  return `export function ${name}(id: string) {\n  const row = db.users.find(id);\n  return ${returns};\n}\n`;
}

const HEADER = `import { db } from "./db";\n\n`;

async function write(w: World, path: string, content: string): Promise<void> {
  const full = join(w.current.dir, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}

async function commitAll(w: World, message: string): Promise<void> {
  await w.git(["add", "-A"]);
  await w.record(`git commit -m ${JSON.stringify(message)}`, () => w.exec(`git commit --quiet -m ${JSON.stringify(message)}`));
  if (w.last?.code !== 0) throw new Error(`commit failed: ${w.last?.stderr}`);
}

function pathOf(w: World, name: string): string {
  const path = w.functions.get(name);
  if (!path) throw new Error(`no function "${name}" was created by a step`);
  return path;
}

// ── shaping code ────────────────────────────────────────────────────

step("I commit {string} with a function {string}", async (w: World, path: string, name: string) => {
  await write(w, path, HEADER + fn(name));
  w.functions.set(name, path);
  await commitAll(w, `Add ${name}`);
});

step("I rename the function {string} to {string} and move it to {string}", async (w: World, from: string, to: string, path: string) => {
  const old = pathOf(w, from);
  await rm(join(w.current.dir, old));
  await write(w, path, HEADER + fn(to));
  w.functions.delete(from);
  w.functions.set(to, path);
  await commitAll(w, `Rename ${from} to ${to}`);
});

step("I change the function {string} with message {string}", async (w: World, name: string, message: string) => {
  const path = pathOf(w, name);
  const full = join(w.current.dir, path);
  const content = await readFile(full, "utf8");
  await writeFile(full, content.replace("  const row = db.users.find(id);", "  const row = db.users.find(id);\n  if (row?.admin) return null;"));
  await commitAll(w, message);
});

step("I replace the function {string} with two copies named {string} and {string}", async (w: World, from: string, a: string, b: string) => {
  const path = pathOf(w, from);
  await write(w, path, HEADER + fn(a) + "\n" + fn(b));
  w.functions.delete(from);
  w.functions.set(a, path);
  w.functions.set(b, path);
  await commitAll(w, `Split ${from}`);
});

step("branch {string} changes the function {string} to return {string}", async (w: World, branch: string, name: string, value: string) => {
  const path = pathOf(w, name);
  await w.git(["checkout", "--quiet", "-b", branch, "main"]);
  const full = join(w.current.dir, path);
  await writeFile(full, (await readFile(full, "utf8")).replace("return row ? row.name : null;", `return ${JSON.stringify(value)};`));
  await commitAll(w, `Return ${value} from ${name}`);
  await w.git(["checkout", "--quiet", "main"]);
});

step("I import {int} functions including {string} into {string} in one commit with message {string}", async (w: World, n: number, name: string, path: string, message: string) => {
  const parts = [HEADER, fn(name)];
  for (let i = 1; i < n; i++) parts.push("\n", fn(`legacy${i}`, `${i}`));
  await write(w, path, parts.join(""));
  w.functions.set(name, path);
  await commitAll(w, message);
});

// ── lineage ─────────────────────────────────────────────────────────

interface Lineage {
  names: string[];
  tier: number;
  steps: Array<{ type: string; name: string; path: string; from?: { name: string; path: string }; tier: number }>;
}

step("the entity {string} is linked to {string} in {string}", async (w: World, name: string, from: string, path: string) => {
  const lineage = await w.sem<Lineage>(`entity ${name}`);
  expect(lineage.names).toContain(from);
  expect(lineage.steps.some((s) => s.from?.name === from && s.from.path === path)).toBe(true);
});

step("the entity {string} is not linked to {string}", async (w: World, name: string, from: string) => {
  const lineage = await w.sem<Lineage>(`entity ${name}`);
  expect(lineage.names).not.toContain(from);
});

step("the lineage of {string} reads {string}", async (w: World, name: string, sequence: string) => {
  const lineage = await w.sem<Lineage>(`entity ${name}`);
  expect(lineage.steps.map((s) => s.type).join(", ")).toBe(sequence);
});

step("the lineage of {string} needed no tier above {int}", async (w: World, name: string, tier: number) => {
  const lineage = await w.sem<Lineage>(`entity ${name}`);
  expect(lineage.tier).toBeLessThanOrEqual(tier);
});

step("the output lists both {string} and {string} as candidates with confidence", (w: World, a: string, b: string) => {
  const out = w.last?.stdout ?? "";
  for (const name of [a, b]) expect(out).toMatch(new RegExp(`^\\s+${name}\\s+\\S+\\s+\\d\\.\\d\\d$`, "m"));
});

step("branches {string} and {string} each show their own version of {string}", async (w: World, a: string, b: string, name: string) => {
  const { versions } = await w.sem<{ versions: Array<{ branch: string; hash: string; body: string }> }>(`entity ${name} --worlds`);
  const va = versions.find((v) => v.branch === a);
  const vb = versions.find((v) => v.branch === b);
  expect(va).toBeDefined();
  expect(vb).toBeDefined();
  expect(va!.hash).not.toBe(vb!.hash);
  expect(w.last?.stdout).toContain(va!.body);
  expect(w.last?.stdout).toContain(vb!.body);
});

// ── why ─────────────────────────────────────────────────────────────

step("the explanation of {string} cites {int} commit(s)", async (w: World, name: string, n: number) => {
  const answer = await w.sem<{ cites: string[] }>(`why ${name}`);
  expect(answer.cites).toHaveLength(n);
});

step("the output does not contain {string}", (w: World, text: string) => {
  expect(w.last?.stdout ?? "").not.toContain(text);
});
