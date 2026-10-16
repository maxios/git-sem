import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { openRepo } from "../repo.ts";

export const HOOK_BEGIN = "# >>> git-sem >>>";
export const HOOK_END = "# <<< git-sem <<<";

/**
 * The hook only appends the new commit id to the queue and, if enabled,
 * starts a detached indexer. It never waits for inference, so commits stay as
 * fast as plain git.
 */
export const HOOK_BLOCK = `${HOOK_BEGIN}
# Enqueue only: inference never runs on the commit path.
_sem_dir="$(git rev-parse --path-format=absolute --git-common-dir)/sem"
mkdir -p "$_sem_dir" && git rev-parse HEAD >> "$_sem_dir/queue"
if [ "$(git config --bool sem.autoindex)" != "false" ] && command -v git-sem >/dev/null 2>&1; then
  (git sem index --background </dev/null >/dev/null 2>&1 &)
fi
${HOOK_END}`;

export function installBlock(existing: string | undefined): string {
  if (existing === undefined || existing.trim() === "") return `#!/bin/sh\n${HOOK_BLOCK}\n`;
  const start = existing.indexOf(HOOK_BEGIN);
  const end = existing.indexOf(HOOK_END);
  if (start >= 0 && end > start) {
    return existing.slice(0, start) + HOOK_BLOCK + existing.slice(end + HOOK_END.length);
  }
  return `${existing.replace(/\n*$/, "\n")}\n${HOOK_BLOCK}\n`;
}

export async function initCommand(_args: string[]): Promise<number> {
  const repo = await openRepo();
  const hookPath = await repo.git.out(["rev-parse", "--path-format=absolute", "--git-path", "hooks/post-commit"]);

  await mkdir(dirname(hookPath), { recursive: true });
  const existing = await readFile(hookPath, "utf8").catch(() => undefined);
  const next = installBlock(existing);
  if (next !== existing) await writeFile(hookPath, next);
  await chmod(hookPath, 0o755);

  // Union semantics when teammates' notes meet: every record is one line, so
  // concatenate-sort-dedupe can never conflict.
  await repo.git.run(["config", "notes.sem.mergeStrategy", "cat_sort_uniq"]);

  console.log(`git-sem initialized
  hook     ${hookPath}
  notes    refs/notes/sem (merge: cat_sort_uniq)
  state    ${repo.semDir}`);
  return 0;
}
