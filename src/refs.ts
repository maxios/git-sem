/**
 * The notes refs git-sem keeps (see sharing.ts for what goes where):
 *
 *   NOTES_REF        shared with the team by `git sem push`
 *   LOCAL_NOTES_REF  this clone only; recomputable, never pushed
 */
export const NOTES_REF = "refs/notes/sem";
export const LOCAL_NOTES_REF = "refs/notes/sem-local";
export const ALL_NOTES_REFS = [NOTES_REF, LOCAL_NOTES_REF] as const;

/** `git log` arguments that attach both refs' notes to %N. */
export function notesArgs(): string[] {
  return ["--no-notes", ...ALL_NOTES_REFS.map((ref) => `--notes=${ref}`)];
}
