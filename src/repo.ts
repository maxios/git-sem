import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "./errors.ts";
import { Git } from "./git.ts";

export interface Repo {
  /** Git bound to the top of the work tree. */
  git: Git;
  /** Absolute path of the work tree. */
  root: string;
  /** Absolute path of the common git dir (shared by all worktrees). */
  commonDir: string;
  /** Where git-sem keeps its local, non-shared state (queue, locks, last run). */
  semDir: string;
}

export async function openRepo(cwd: string = process.cwd()): Promise<Repo> {
  const probe = new Git(cwd);
  const r = await probe.run(
    ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--path-format=absolute", "--git-common-dir"],
    { allowFail: true },
  );
  if (r.code !== 0) throw new UserError("not a git repository");
  const [inside, root, commonDir] = r.stdout.trim().split("\n");
  if (inside !== "true" || !root || !commonDir) throw new UserError("git-sem must run inside a work tree");

  const semDir = join(commonDir, "sem");
  await mkdir(semDir, { recursive: true });
  return { git: new Git(root), root, commonDir, semDir };
}
