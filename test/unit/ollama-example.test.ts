/**
 * The Ollama example engine, run as a real process against a mock Ollama
 * server, for every task git-sem sends, and through git-sem's own commands.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnText } from "../../src/proc.ts";

const ROOT = resolve(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "examples/engines/ollama.ts");
const CLI = join(ROOT, "src/cli.ts");

interface Seen {
  model: string;
  prompt: string;
  format: unknown;
  options: { num_ctx: number; temperature: number };
}

let seen: Seen[] = [];
let reply: (req: Seen) => unknown = () => ({ text: "ok", confidence: 0.7 });
let server: ReturnType<typeof Bun.serve>;
let host: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Seen;
      seen.push(body);
      return Response.json({ response: JSON.stringify(reply(body)) });
    },
  });
  host = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

afterEach(() => {
  seen = [];
  reply = () => ({ text: "ok", confidence: 0.7 });
});

async function run(input: unknown): Promise<{ code: number; out: { text: string; confidence: number; questions: string[] } | null; err: string }> {
  const r = await spawnText([process.execPath, EXAMPLE], {
    cwd: ROOT,
    input: JSON.stringify(input),
    env: { ...process.env, OLLAMA_HOST: host },
  });
  return { code: r.code, out: r.code === 0 ? JSON.parse(r.stdout) : null, err: r.stderr.trim() };
}

const base = { protocol: 1, model: "llama3.2:3b", promptVersion: "intent/v1" };

describe("every task git-sem sends", () => {
  test("intent", async () => {
    const r = await run({ ...base, task: "intent", commit: null, subject: "Cap retries", body: "", changes: [{ status: "M", path: "a.ts" }], diff: "+x" });
    expect(r.code).toBe(0);
    expect(r.out).toEqual({ text: "ok", confidence: 0.7, questions: [] });
    expect(seen[0]!.prompt).toContain("Commit subject: Cap retries");
    expect(seen[0]!.format).toMatchObject({ required: ["text", "confidence"] });
  });

  test("summarize: a branch's intents become one", async () => {
    reply = () => ({ text: "  Make retries safe under load.  ", confidence: 0.6 });
    const r = await run({ ...base, task: "summarize", subject: "feature/retries", intents: ["Cap retries at three", "Add jitter to backoff"] });
    expect(r.code).toBe(0);
    expect(r.out?.text).toBe("Make retries safe under load.");
    expect(seen[0]!.prompt).toContain("Branch: feature/retries");
    expect(seen[0]!.prompt).toContain("- Add jitter to backoff");
  });

  test("resolve: the whole file comes back exactly, whitespace included", async () => {
    const file = "  indented first line\nRETRIES=4\nRETRIES=5\n\n";
    reply = () => ({ text: file, confidence: 0.8 });
    const r = await run({ ...base, task: "resolve", path: "config.env", base: "RETRIES=3\n", ours: "RETRIES=4\n", theirs: "RETRIES=5\n", oursIntents: [], theirsIntents: [] });
    expect(r.code).toBe(0);
    expect(r.out?.text).toBe(file);
    expect(seen[0]!.prompt).toContain("=== OURS ===\nRETRIES=4");
    expect(seen[0]!.prompt).toContain("=== THEIRS ===\nRETRIES=5");
    expect(seen[0]!.options).toEqual({ num_ctx: 16384, temperature: 0 });
  });

  test("resolve: a file too large for the context is refused, not cut", async () => {
    const big = "x".repeat(20_000);
    const r = await run({ ...base, task: "resolve", path: "big.ts", base: big, ours: big, theirs: big });
    expect(r.code).toBe(2);
    expect(r.err).toContain("too large to resolve");
    expect(seen).toHaveLength(0);
  });

  test("resolve: an answer that still has conflict markers is rejected", async () => {
    reply = () => ({ text: "<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n", confidence: 0.9 });
    const r = await run({ ...base, task: "resolve", path: "f", base: "", ours: "A\n", theirs: "B\n" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("conflict markers");
  });

  test("contradictions: both sides and git-sem's own warnings reach the model", async () => {
    reply = () => ({ text: "Both branches assume they own sessions.", confidence: 0.7, questions: ["Which module owns sessions?"] });
    const r = await run({
      ...base,
      task: "contradictions",
      a: { ref: "a", intents: ["Auth owns sessions"] },
      b: { ref: "b", intents: ["Cache owns sessions"] },
      warnings: ["createSession is defined in two files"],
    });
    expect(r.code).toBe(0);
    expect(r.out?.questions).toEqual(["Which module owns sessions?"]);
    expect(seen[0]!.prompt).toContain("Branch a, intents:\n- Auth owns sessions");
    expect(seen[0]!.prompt).toContain("- createSession is defined in two files");
  });

  test("an unknown task fails clearly instead of crashing", async () => {
    const r = await run({ ...base, task: "translate" });
    expect(r.code).toBe(2);
    expect(r.err).toBe("unsupported task: translate");
  });
});

describe("through git-sem", () => {
  let dir: string;
  const env = () => ({
    ...process.env,
    OLLAMA_HOST: host,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@x",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@x",
    GIT_CONFIG_NOSYSTEM: "1",
  });
  const sh = async (cmd: string) => {
    const r = await spawnText(["sh", "-c", cmd], { cwd: dir, env: env() });
    if (r.code !== 0) throw new Error(`${cmd}\n${r.stderr}`);
    return r.stdout;
  };
  const sem = (args: string) => sh(`"${process.execPath}" "${CLI}" ${args}`);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "git-sem-ollama-"));
    const engine = `"${process.execPath}" "${EXAMPLE}"`;
    await sh(`git init -q -b main && git config sem.autoindex false && git config sem.engine command && git config sem.model m && git config sem.command '${engine}'`);
    await sh(`git config sem.frontier.command '${engine}' && git config sem.frontier.model big`);
    await writeFile(join(dir, "config.env"), "RETRIES=3\n");
    await sh(`git add -A && git commit -qm base`);
    await sh(`git switch -qc a && echo 'RETRIES=4' > config.env && git commit -qam "Raise retries"`);
    await sh(`git switch -q main && git switch -qc b && echo 'RETRIES=5' > config.env && git commit -qam "Raise retries more"`);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("git sem intent --branch", async () => {
    reply = (req) => ({ text: req.prompt.includes("Branch: a") ? "Retries go up on branch a." : "ok", confidence: 0.6 });
    await sem("index --all -q");
    expect(await sem("intent --branch a --base main")).toContain("Branch intent: Retries go up on branch a.");
  });

  test("git sem check --deep", async () => {
    reply = (req) => ({ text: req.model === "big" ? "No contradiction found." : "ok", confidence: 0.8 });
    expect(await sem("check a b --deep")).toContain("Tier 3 review (big, confidence 0.80): No contradiction found.");
  });

  test("git sem resolve proposes, and --accept writes the model's file", async () => {
    await sh("git switch -q a && (git merge -q b || true)");
    reply = (req) => ({ text: req.prompt.includes("=== OURS ===") ? "RETRIES=4\nRETRIES=5\n" : "ok", confidence: 0.8 });
    expect(await sem("resolve config.env")).toContain("not written");
    expect(await readFile(join(dir, "config.env"), "utf8")).toContain("<<<<<<<");
    await sem("resolve config.env --accept");
    expect(await readFile(join(dir, "config.env"), "utf8")).toBe("RETRIES=4\nRETRIES=5\n");
  });
});
