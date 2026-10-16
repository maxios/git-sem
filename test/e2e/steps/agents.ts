import { expect } from "bun:test";
import { join, resolve } from "node:path";
import { spawnText } from "../../../src/proc.ts";
import { step } from "../support/registry.ts";
import type { World } from "../support/world.ts";

const API = join(resolve(import.meta.dir, "../../.."), "src/api.ts");
const results = new WeakMap<World, unknown>();

/** Speak MCP to `git sem mcp` over stdio and return the response to the last request. */
async function mcp(w: World, client: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: client, version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool, arguments: args } },
  ];
  const r = await spawnText(["git", "sem", "mcp"], {
    cwd: w.current.dir,
    env: w.env,
    input: `${requests.map((x) => JSON.stringify(x)).join("\n")}\n`,
  });
  if (r.code !== 0) throw new Error(`git sem mcp exited ${r.code}: ${r.stderr}`);
  const replies = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: number; result?: any; error?: unknown });
  expect(replies.map((x) => x.id)).toEqual([1, 2, 3]);
  expect(replies[1]?.result.tools.map((t: { name: string }) => t.name)).toContain(tool);
  const call = replies[2]!;
  if (call.error || call.result?.isError) throw new Error(`MCP call failed: ${JSON.stringify(call)}`);
  return call.result.structuredContent.result;
}

step("an agent calls entity {string} through the library", async (w: World, name: string) => {
  const script = `const { openSemantic } = await import(${JSON.stringify(API)}); const sem = await openSemantic(process.cwd()); console.log(JSON.stringify(await sem.entity(${JSON.stringify(name)})));`;
  const r = await spawnText([process.execPath, "-e", script], { cwd: w.current.dir, env: w.env });
  if (r.code !== 0) throw new Error(`library call failed: ${r.stderr}`);
  results.set(w, JSON.parse(r.stdout));
});

step("an agent calls the MCP tool {string} with name {string}", async (w: World, tool: string, name: string) => {
  results.set(w, await mcp(w, "test-agent", tool, { name }));
});

step("an agent named {string} proposes {string} for HEAD over MCP", async (w: World, agent: string, text: string) => {
  await mcp(w, agent, "sem_propose_intent", { rev: "HEAD", text });
});

step("it receives JSON with versions, intents and commit hashes for {string}", (w: World, name: string) => {
  const r = results.get(w) as {
    name: string;
    names: string[];
    versions: Array<{ commit: string; type: string; intent: { text: string } | null; blob: string | null }>;
  };
  expect(r.name).toBe(name);
  expect(r.names).toEqual(["loadUser", "fetchUser"]);
  expect(r.versions.map((v) => v.type)).toEqual(["renamed", "added"]);
  for (const v of r.versions) {
    expect(v.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(v.blob).toMatch(/^[0-9a-f]{40}$/);
    expect(v.intent?.text).toBeTruthy();
  }
});

interface ShowJson {
  intent: { source: string } | null;
  artifacts: Array<{ kind: string; source: string; engine: string; model: string }>;
}

step("HEAD has a proposal from agent {string}", async (w: World, agent: string) => {
  const show = await w.sem<ShowJson>("show HEAD");
  expect(show.artifacts.some((a) => a.kind === "intent" && a.source === "inferred" && a.engine === "agent" && a.model === agent)).toBe(true);
});

step("HEAD has no authored intent", async (w: World) => {
  const show = await w.sem<ShowJson>("show HEAD");
  expect(show.artifacts.some((a) => a.kind === "intent" && a.source === "authored")).toBe(false);
  expect(show.intent?.source).not.toBe("authored");
});
