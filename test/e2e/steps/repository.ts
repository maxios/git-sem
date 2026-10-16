import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { step } from "../support/registry.ts";
import { FAKE_ENGINE, type World } from "../support/world.ts";

// ── repositories and teammates ──────────────────────────────────────

step("a git repository with the semantic layer initialized", async (w: World) => {
  const dir = join(w.root, "repo");
  await mkdir(dir);
  w.addRepo("main", dir);
  w.use("main");
  await w.git(["init", "--quiet"]);
  await w.must("git sem init");
});

step("a git repository with {int} existing commits", async (w: World, n: number) => {
  const dir = join(w.root, "repo");
  await mkdir(dir);
  w.addRepo("main", dir);
  w.use("main");
  await w.git(["init", "--quiet"]);
  for (let i = 1; i <= n; i++) {
    await writeFile(join(dir, `module${i}.ts`), `export const m${i} = ${i};\n`);
    await w.git(["add", "--", `module${i}.ts`]);
    await w.git(["commit", "--quiet", "-m", `Add module ${i}`]);
  }
});

step("a shared remote {string}", async (w: World, name: string) => {
  const bare = join(w.root, `${name}.git`);
  const seed = join(w.root, `${name}-seed`);
  await w.git(["init", "--quiet", "--bare", bare], w.root);
  await w.git(["clone", "--quiet", bare, seed], w.root);
  await writeFile(join(seed, "README.md"), "# shared\n");
  await w.git(["add", "README.md"], seed);
  await w.git(["commit", "--quiet", "-m", "Initial commit"], seed);
  await w.git(["push", "--quiet", "origin", "HEAD:main"], seed);
  w.remotes.set(name, bare);
});

step("{string} has cloned {string} with the semantic layer initialized", async (w: World, who: string, remote: string) => {
  const dir = join(w.root, who);
  await w.git(["clone", "--quiet", w.remote(remote), dir], w.root);
  w.addRepo(who, dir);
  await w.git(["config", "user.name", who], dir);
  await w.git(["config", "user.email", `${who}@example.com`], dir);
  await w.must("git sem init", dir);
});

step("I am {string}", (w: World, who: string) => w.use(who));

// ── configuration ───────────────────────────────────────────────────

function fakeEngineCommand(w: World, delayMs = 0): string {
  return `"${process.execPath}" "${FAKE_ENGINE}" "${w.current.engineLog}" ${delayMs}`;
}

step("the semantic engine is the test engine with model {string}", async (w: World, model: string) => {
  await w.git(["config", "sem.engine", "command"]);
  await w.git(["config", "sem.command", fakeEngineCommand(w)]);
  await w.git(["config", "sem.model", model]);
  await w.git(["config", "sem.tier", "2"]);
});

step("the test engine takes {int} milliseconds to respond", async (w: World, delayMs: number) => {
  await w.git(["config", "sem.command", fakeEngineCommand(w, delayMs)]);
});

step("the semantic engine is the heuristic engine", async (w: World) => {
  await w.git(["config", "sem.engine", "heuristic"]);
});

step("the semantic engine model is changed to {string}", async (w: World, model: string) => {
  await w.git(["config", "sem.model", model]);
});

step("the prompt version is changed to {string}", async (w: World, version: string) => {
  await w.git(["config", "sem.promptVersion", version]);
});

step("background indexing is disabled", async (w: World) => {
  await w.git(["config", "sem.autoindex", "false"]);
});

step("background indexing is enabled", async (w: World) => {
  await w.git(["config", "sem.autoindex", "true"]);
});

step("background indexing is disabled for all teammates", async (w: World) => {
  for (const repo of w.repos.values()) await w.git(["config", "sem.autoindex", "false"], repo.dir);
});

// ── changes and commits ─────────────────────────────────────────────

async function touch(w: World, path: string): Promise<void> {
  const full = join(w.current.dir, path);
  await mkdir(dirname(full), { recursive: true });
  await appendFile(full, `// change ${w.nextChange()}\n`);
  await w.git(["add", "--", path]);
}

async function commit(w: World, message: string): Promise<void> {
  await w.record(`git commit -m ${JSON.stringify(message)}`, () =>
    w.exec(`git commit --quiet -m ${JSON.stringify(message)}`),
  );
  if (w.last?.code !== 0) throw new Error(`commit failed: ${w.last?.stderr}`);
}

step("I commit a change to {string}", async (w: World, path: string) => {
  await touch(w, path);
  await commit(w, `Change ${path}`);
});

step("I commit a change to {string} with message {string}", async (w: World, path: string, message: string) => {
  await touch(w, path);
  await commit(w, message);
});

step("I commit {string} with content {string}", async (w: World, path: string, content: string) => {
  const full = join(w.current.dir, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, `${content}\n`);
  await w.git(["add", "--", path]);
  await commit(w, `Set ${path} to ${content}`);
});

step("I stage a change to {string}", async (w: World, path: string) => {
  await touch(w, path);
});

step("I stage {string} with content {string}", async (w: World, path: string, content: string) => {
  const full = join(w.current.dir, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, `${content}\n`);
  await w.git(["add", "--", path]);
});

step("I tag the latest commit as {string}", async (w: World, tag: string) => {
  await w.git(["tag", tag]);
});

// ── running commands ────────────────────────────────────────────────

step("I run {string}", async (w: World, command: string) => {
  const r = await w.record(command, () => w.exec(command));
  if (r.code !== 0) throw new Error(`"${command}" exited ${r.code}\n${r.stderr || r.stdout}`);
});
