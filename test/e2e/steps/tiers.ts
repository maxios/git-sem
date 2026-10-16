import { expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { step } from "../support/registry.ts";
import { FAKE_ENGINE, type World } from "../support/world.ts";

function frontierLog(w: World): string {
  return `${w.current.engineLog}.frontier`;
}

async function frontierCalls(w: World): Promise<number> {
  return (await readFile(frontierLog(w), "utf8").catch(() => "")).split("\n").filter(Boolean).length;
}

const asked = new WeakMap<World, { tier: number; engine: number; frontier: number }>();

step("the frontier engine is the test engine with model {string}", async (w: World, model: string) => {
  await w.git(["config", "sem.frontier.command", `"${process.execPath}" "${FAKE_ENGINE}" "${frontierLog(w)}"`]);
  await w.git(["config", "sem.frontier.model", model]);
});

step("the frontier daily budget is {int}", async (w: World, n: number) => {
  await w.git(["config", "sem.frontier.dailyBudget", String(n)]);
});

step("I try to run {string}", async (w: World, command: string) => {
  await w.record(command, () => w.exec(command));
});

step("it fails with a message containing {string}", (w: World, text: string) => {
  expect(w.last?.code).not.toBe(0);
  expect(w.last?.stderr).toContain(text);
});

step("the frontier engine has been invoked {int} time(s)", async (w: World, n: number) => {
  expect(await frontierCalls(w)).toBe(n);
});

step("I ask {string} with {string}", async (w: World, _question: string, command: string) => {
  const engineBefore = await w.engineCalls();
  const frontierBefore = await frontierCalls(w);
  const r = await w.record(command, () => w.exec(`${command} --json`));
  if (r.code !== 0) throw new Error(`"${command}" exited ${r.code}\n${r.stderr}`);
  const json = JSON.parse(r.stdout) as { tier?: number; engine?: { tier: number } };
  const tier = json.tier ?? json.engine?.tier;
  if (tier === undefined) throw new Error(`"${command} --json" reports no tier`);
  asked.set(w, { tier, engine: (await w.engineCalls()) - engineBefore, frontier: (await frontierCalls(w)) - frontierBefore });
});

step("it is answered at tier {int}", (w: World, tier: number) => {
  expect(asked.get(w)?.tier).toBe(tier);
});

step("no engine above tier {int} was invoked", (w: World, tier: number) => {
  const a = asked.get(w)!;
  // The intent engine is Tier 2 and the frontier engine Tier 3.
  if (tier < 2) expect(a.engine).toBe(0);
  if (tier < 3) expect(a.frontier).toBe(0);
});
