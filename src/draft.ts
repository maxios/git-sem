import { parseNote, resolveIntent, type ChangeEntry, type EngineIdentity, type Source } from "./artifacts.ts";
import { stagedChanges, stagedDiff } from "./changes.ts";
import type { Engine, IntentProposal } from "./engines/index.ts";
import { identityOf } from "./engines/index.ts";
import type { Git } from "./git.ts";
import { notesArgs } from "./refs.ts";

/** A past commit that touched the same files, with its recorded meaning. */
export interface HistoryEntry {
  commit: string;
  subject: string;
  intent: string | null;
  source: Source | null;
  /** Which of the staged paths this commit touched. */
  paths: string[];
}

/**
 * The staged change puts a file back exactly as it was before `commit`
 * changed it. Detected by blob identity: Tier 0, no model involved.
 */
export interface Reversal {
  path: string;
  commit: string;
  subject: string;
  intent: string | null;
  source: Source | null;
}

export interface Draft {
  subject: string;
  proposal: IntentProposal;
  questions: string[];
  reversals: Reversal[];
  history: HistoryEntry[];
  engine: EngineIdentity & { tier: number };
  changes: ChangeEntry[];
}

const HISTORY_LIMIT = 20;
const REVERSAL_DEPTH = 50;
const MAX_PATHS = 20;

export function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

function touchedPaths(changes: ChangeEntry[]): string[] {
  const paths = new Set<string>();
  for (const c of changes) {
    paths.add(c.path);
    if (c.from) paths.add(c.from);
  }
  return [...paths].slice(0, MAX_PATHS);
}

/** Recent commits touching any staged path, read together with their notes. Lookup only. */
export async function relatedHistory(git: Git, changes: ChangeEntry[], current?: EngineIdentity): Promise<HistoryEntry[]> {
  if (!(await git.resolve("HEAD"))) return [];
  const paths = touchedPaths(changes);
  if (paths.length === 0) return [];

  const out = (
    await git.run([
      "log",
      `--max-count=${HISTORY_LIMIT}`,
      ...notesArgs(),
      "--name-only",
      "--format=%x1e%H%x1f%s%x1f%N%x1f",
      "HEAD",
      "--",
      ...paths,
    ])
  ).stdout;

  const wanted = new Set(paths);
  const entries: HistoryEntry[] = [];
  for (const raw of out.split("\x1e")) {
    if (!raw.trim()) continue;
    const [commit = "", subject = "", note = "", files = ""] = raw.split("\x1f");
    const intent = resolveIntent(parseNote(note), current);
    entries.push({
      commit,
      subject,
      intent: (intent?.value as { text?: string } | undefined)?.text ?? null,
      source: intent?.source ?? null,
      paths: files.split("\n").map((f) => f.trim()).filter((f) => wanted.has(f)),
    });
  }
  return entries;
}

/** Find staged files that return to a state an earlier commit moved away from. */
export async function findReversals(git: Git, changes: ChangeEntry[], history: HistoryEntry[]): Promise<Reversal[]> {
  if (!(await git.resolve("HEAD"))) return [];
  const known = new Map(history.map((h) => [h.commit, h]));
  const reversals: Reversal[] = [];

  for (const change of changes.slice(0, MAX_PATHS)) {
    if (change.status !== "M" || !change.blob) continue;
    const out = (
      await git.run([
        "log",
        `--max-count=${REVERSAL_DEPTH}`,
        "--raw",
        "--no-abbrev",
        "--no-renames",
        "--format=%x1e%H%x1f%s",
        "HEAD",
        "--",
        change.path,
      ])
    ).stdout;

    for (const raw of out.split("\x1e")) {
      const [headLine = "", ...rest] = raw.trim().split("\n");
      const [commit = "", subject = ""] = headLine.split("\x1f");
      const line = rest.find((l) => l.startsWith(":") && l.endsWith(`\t${change.path}`));
      if (!commit || !line) continue;
      const oldBlob = line.slice(1).split(" ")[2];
      if (oldBlob !== change.blob) continue;
      const h = known.get(commit);
      reversals.push({ path: change.path, commit, subject, intent: h?.intent ?? null, source: h?.source ?? null });
      break; // the most recent such commit is the one being undone
    }
  }
  return reversals;
}

/**
 * Build a commit message draft for the staged changes.
 *
 * Everything except the engine call is lookup. The draft proposes; it never
 * invents a reason: low confidence and reversals become questions for the
 * author instead of confident prose.
 */
export async function buildDraft(git: Git, engine: Engine): Promise<Draft | null> {
  const changes = await stagedChanges(git);
  if (changes.length === 0) return null;

  const identity = identityOf(engine);
  const history = await relatedHistory(git, changes, identity);
  const reversals = await findReversals(git, changes, history);

  const proposal = await engine.proposeIntent({
    protocol: 1,
    task: "intent",
    model: engine.model,
    promptVersion: engine.promptVersion,
    commit: null,
    subject: "",
    body: "",
    changes,
    diff: engine.wantsDiff ? await stagedDiff(git) : "",
    history,
    reversals,
  });

  const questions = [...(proposal.questions ?? [])];
  for (const r of reversals) {
    const why = r.intent ? `, whose intent was "${firstLine(r.intent)}"` : "";
    questions.push(`This undoes ${r.commit.slice(0, 7)} on ${r.path}${why}. Is that intended, and why?`);
  }
  if (proposal.confidence < 0.5) questions.push("Why is this change needed? The draft only says what changed.");

  return {
    subject: firstLine(proposal.text),
    proposal,
    questions,
    reversals,
    history,
    engine: { ...identity, tier: engine.tier },
    changes,
  };
}

/** The draft as an editor template: the subject, then guidance as `#` comments git strips. */
export function renderTemplate(draft: Draft): string {
  const lines = [draft.subject, ""];
  const c = (s = "") => lines.push(s ? `# ${s}` : "#");

  c(
    `git-sem draft · engine=${draft.engine.engine} model=${draft.engine.model}` +
      ` confidence=${draft.proposal.confidence.toFixed(2)}`,
  );
  for (const r of draft.reversals) {
    c();
    c(`WARNING: this reverts ${r.commit.slice(0, 7)} "${r.subject}" on ${r.path}`);
    if (r.intent) c(`  its intent: ${firstLine(r.intent)}${r.source === "authored" ? " [authored]" : ""}`);
  }
  if (draft.questions.length) {
    c();
    c("Questions for you:");
    for (const q of draft.questions) c(`  - ${q}`);
  }
  if (draft.history.length) {
    c();
    c("Related history (touched the same files):");
    for (const h of draft.history.slice(0, 10)) {
      const meaning = h.intent ? `${firstLine(h.intent)}${h.source === "authored" ? " [authored]" : ""}` : `${h.subject} [pending]`;
      c(`  ${h.commit.slice(0, 7)}  ${meaning}  (${h.paths.join(", ")})`);
    }
  }
  c();
  c("Lines starting with '#' are removed. An empty message aborts the commit.");
  return `${lines.join("\n")}\n`;
}
