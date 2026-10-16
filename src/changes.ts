import type { ChangeEntry } from "./artifacts.ts";
import type { Git } from "./git.ts";

const ZERO = /^0+$/;

/** Parse `--raw -z` diff output (diff-tree, diff --cached) into change entries. */
export function parseRawZ(out: string): ChangeEntry[] {
  const parts = out.split("\0");
  const entries: ChangeEntry[] = [];
  let i = 0;
  while (i < parts.length) {
    const head = parts[i++];
    if (!head || !head.startsWith(":")) continue;
    const [, dstMode, , dstSha, statusField = ""] = head.slice(1).split(" ");
    const status = statusField.charAt(0);
    const score = statusField.slice(1);
    const blob = dstSha && !ZERO.test(dstSha) ? dstSha : undefined;

    if (status === "R" || status === "C") {
      const from = parts[i++] ?? "";
      const path = parts[i++] ?? "";
      entries.push({ status, path, from, blob, mode: dstMode, similarity: score ? Number(score) : undefined });
    } else {
      const path = parts[i++] ?? "";
      entries.push({ status, path, blob, mode: dstMode });
    }
  }
  return entries;
}

/** Changes a commit introduces relative to its first parent (or the empty tree for a root commit). */
export async function commitChanges(git: Git, commit: string, parents: string[]): Promise<ChangeEntry[]> {
  const base = parents[0] ?? (await git.emptyTree());
  const r = await git.run(["diff-tree", "-r", "-M", "--raw", "-z", "--no-abbrev", base, commit]);
  return parseRawZ(r.stdout);
}

export async function stagedChanges(git: Git): Promise<ChangeEntry[]> {
  const r = await git.run(["diff", "--cached", "-M", "--raw", "-z", "--no-abbrev"]);
  return parseRawZ(r.stdout);
}

const MAX_DIFF_CHARS = 40_000;

function truncate(diff: string): string {
  return diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]\n` : diff;
}

export async function commitDiff(git: Git, commit: string, parents: string[]): Promise<string> {
  const base = parents[0] ?? (await git.emptyTree());
  return truncate(await git.out(["diff", "--no-color", "--no-ext-diff", "-M", base, commit]));
}

export async function stagedDiff(git: Git): Promise<string> {
  return truncate(await git.out(["diff", "--cached", "--no-color", "--no-ext-diff", "-M"]));
}

/** Regular files only (not symlinks or submodules). */
export function isRegularFile(entry: ChangeEntry): boolean {
  return entry.mode === "100644" || entry.mode === "100755";
}
