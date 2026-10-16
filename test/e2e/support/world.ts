import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnText } from "../../../src/proc.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "../../..");
const CLI = join(PROJECT_ROOT, "src/cli.ts");
export const FAKE_ENGINE = join(import.meta.dir, "fake-engine.ts");

const GITCONFIG = `[user]
\tname = Test User
\temail = test@example.com
[init]
\tdefaultBranch = main
[pull]
\trebase = false
[commit]
\tgpgsign = false
[advice]
\tdetachedHead = false
`;

export interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  code: number;
  ms: number;
}

export interface LastRun extends CommandResult {
  engineCallsBefore: number;
  engineCallsAfter: number;
}

export interface RepoHandle {
  name: string;
  dir: string;
  /** Log of every fake-engine invocation made on behalf of this repository. */
  engineLog: string;
}

/**
 * A sandbox per scenario: its own HOME and git config, a `git-sem` shim on
 * PATH, and any number of repositories and bare remotes. Commands run as real
 * processes, exactly as a user would type them.
 */
export class World {
  readonly repos = new Map<string, RepoHandle>();
  readonly remotes = new Map<string, string>();
  last?: LastRun;
  private currentName?: string;
  private changeCounter = 0;

  private constructor(
    readonly root: string,
    readonly env: Record<string, string>,
  ) {}

  static async create(): Promise<World> {
    const root = await mkdtemp(join(tmpdir(), "git-sem-e2e-"));
    const home = join(root, "home");
    const bin = join(root, "bin");
    await mkdir(home);
    await mkdir(bin);
    await writeFile(join(home, ".gitconfig"), GITCONFIG);
    await writeFile(join(bin, "git-sem"), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
    }
    Object.assign(env, {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    return new World(root, env);
  }

  addRepo(name: string, dir: string): RepoHandle {
    const handle = { name, dir, engineLog: join(this.root, `engine-${name}.log`) };
    this.repos.set(name, handle);
    this.currentName ??= name;
    return handle;
  }

  use(name: string): void {
    if (!this.repos.has(name)) throw new Error(`no repository named "${name}"`);
    this.currentName = name;
  }

  get current(): RepoHandle {
    const repo = this.currentName ? this.repos.get(this.currentName) : undefined;
    if (!repo) throw new Error("no current repository; a Given step must create one first");
    return repo;
  }

  remote(name: string): string {
    const dir = this.remotes.get(name);
    if (!dir) throw new Error(`no remote named "${name}"`);
    return dir;
  }

  /** Run a shell command and return its result without asserting. */
  async exec(command: string, cwd: string = this.current.dir): Promise<CommandResult> {
    const started = performance.now();
    const r = await spawnText(["sh", "-c", command], { cwd, env: this.env });
    return { command, stdout: r.stdout, stderr: r.stderr, code: r.code, ms: performance.now() - started };
  }

  /** Run a command that must succeed. */
  async must(command: string, cwd?: string): Promise<CommandResult> {
    const r = await this.exec(command, cwd);
    if (r.code !== 0) throw new Error(`command failed (${r.code}): ${command}\n${r.stderr || r.stdout}`);
    return r;
  }

  /** Run git with exact arguments (no shell quoting involved). */
  async git(args: string[], cwd: string = this.current.dir): Promise<CommandResult> {
    const started = performance.now();
    const r = await spawnText(["git", ...args], { cwd, env: this.env });
    const result = { command: `git ${args.join(" ")}`, stdout: r.stdout, stderr: r.stderr, code: r.code, ms: performance.now() - started };
    if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr}`);
    return result;
  }

  /** Run a command as the user's action under test; records the result and engine usage. */
  async record(command: string, run: () => Promise<CommandResult>): Promise<LastRun> {
    const before = await this.engineCalls();
    const result = await run();
    const after = await this.engineCalls();
    this.last = { ...result, command, engineCallsBefore: before, engineCallsAfter: after };
    return this.last;
  }

  async engineCalls(repo: RepoHandle = this.current): Promise<number> {
    const text = await readFile(repo.engineLog, "utf8").catch(() => "");
    return text.split("\n").filter(Boolean).length;
  }

  /** Inspect git-sem state as JSON. Not recorded as the last command. */
  async sem<T>(args: string): Promise<T> {
    const r = await this.must(`git sem ${args} --json`);
    return JSON.parse(r.stdout) as T;
  }

  async semDir(): Promise<string> {
    const r = await this.git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return join(r.stdout.trim(), "sem");
  }

  async revParse(rev: string): Promise<string> {
    return (await this.git(["rev-parse", rev])).stdout.trim();
  }

  async commitBySubject(subject: string): Promise<string> {
    const out = (await this.git(["log", "--format=%H%x09%s"])).stdout;
    const line = out.split("\n").find((l) => l.split("\t")[1] === subject);
    if (!line) throw new Error(`no commit with subject "${subject}"`);
    return line.split("\t")[0]!;
  }

  nextChange(): number {
    return ++this.changeCounter;
  }

  async dispose(): Promise<void> {
    // Let any background indexer finish before removing its repository.
    for (const repo of this.repos.values()) {
      const lock = join(repo.dir, ".git", "sem", "index.lock");
      const deadline = Date.now() + 5_000;
      while (existsSync(lock) && Date.now() < deadline) await Bun.sleep(50);
    }
    await rm(this.root, { recursive: true, force: true });
  }
}
