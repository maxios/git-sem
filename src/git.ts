import { spawnBytes, spawnText, type RunResult } from "./proc.ts";

export interface GitRunOptions {
  input?: string;
  allowFail?: boolean;
}

export class GitError extends Error {
  override name = "GitError";
  constructor(
    readonly args: readonly string[],
    readonly result: RunResult,
  ) {
    super(`git ${args.join(" ")} exited ${result.code}: ${result.stderr.trim()}`);
  }
}

/** Thin wrapper over the git CLI. Plumbing commands only; no porcelain parsing. */
export class Git {
  constructor(readonly cwd: string) {}

  async run(args: string[], opts: GitRunOptions = {}): Promise<RunResult> {
    const result = await spawnText(["git", ...args], { cwd: this.cwd, input: opts.input });
    if (result.code !== 0 && !opts.allowFail) throw new GitError(args, result);
    return result;
  }

  /** Run and return trimmed stdout; throws on failure. */
  async out(args: string[], opts: Omit<GitRunOptions, "allowFail"> = {}): Promise<string> {
    return (await this.run(args, opts)).stdout.trim();
  }

  async bytes(args: string[]): Promise<Uint8Array> {
    const { bytes, code } = await spawnBytes(["git", ...args], this.cwd);
    if (code !== 0) throw new GitError(args, { stdout: "", stderr: "", code, timedOut: false });
    return bytes;
  }

  /** Resolve a revision to a full object id, or undefined if it does not exist. */
  async resolve(rev: string): Promise<string | undefined> {
    const r = await this.run(["rev-parse", "--verify", "--quiet", `${rev}^{object}`], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  private emptyTreeId?: string;

  /** The id of the empty tree for this repository's hash algorithm. */
  async emptyTree(): Promise<string> {
    this.emptyTreeId ??= await this.out(["hash-object", "-t", "tree", "--stdin"], { input: "" });
    return this.emptyTreeId;
  }
}
