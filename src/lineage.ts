import { keyOf, parseNote, resolveIntent, type ArtifactRecord, type ChangesValue, type EngineIdentity, type Source } from "./artifacts.ts";
import { CatFile } from "./batch.ts";
import { extractEntities, bodyOf, languageOf, type EntityEvent, type EntityRef } from "./entities.ts";
import { CHANGES_KEY, commitsWithNotes, eventsForCommit, linksIn } from "./entity-git.ts";
import type { Git } from "./git.ts";

export interface IntentSummary {
  text: string;
  source: Source;
  confidence: number;
  engine: string;
  model: string;
}

export interface LineageStep {
  commit: string;
  subject: string;
  type: EntityEvent["type"];
  name: string;
  path: string;
  from?: EntityRef;
  candidates?: Array<EntityRef & { score: number }>;
  score?: number;
  tier: 0 | 1;
  /** Set when a person confirmed which candidate an ambiguous succession led to. */
  confirmed?: boolean;
  /** Blob holding this version of the entity, when known. */
  blob?: string;
  intent: IntentSummary | null;
  /** How many entities this commit added: large numbers mean a bulk import. */
  addedInCommit: number;
}

export interface Lineage {
  name: string;
  /** Every name this entity has had, newest first. */
  names: string[];
  steps: LineageStep[];
  /** Ambiguous successions nobody has confirmed yet. */
  unresolved: LineageStep[];
  /** Highest tier any link relied on: 0 exact, 1 similarity. */
  tier: 0 | 1;
}

function summary(r: ArtifactRecord | undefined): IntentSummary | null {
  const text = (r?.value as { text?: string } | undefined)?.text;
  if (!r || text === undefined) return null;
  return { text, source: r.source, confidence: r.confidence, engine: r.engine, model: r.model };
}

/**
 * Follow an entity back through history. Renames and moves are followed;
 * an ambiguous succession is followed only after a person confirms it.
 */
export async function entityLineage(git: Git, name: string, current?: EngineIdentity): Promise<Lineage> {
  const commits = (await git.resolve("HEAD")) ? await commitsWithNotes(git, ["HEAD"]) : [];
  const cat = new CatFile(git.cwd);
  const tracked = new Set([name]);
  const names = [name];
  const steps: LineageStep[] = [];
  const unresolved: LineageStep[] = [];
  let tier: 0 | 1 = 0;

  try {
    for (const c of commits) {
      const events = await eventsForCommit(git, cat, c.commit, c.parents, c.note);
      const records = parseNote(c.note);
      const links = linksIn(records);
      const changes = records.find((r) => keyOf(r) === CHANGES_KEY)?.value as ChangesValue | undefined;
      const blobOf = (path: string) => changes?.paths.find((p) => p.path === path)?.blob;
      const intent = summary(resolveIntent(records, current));
      const addedInCommit = events.filter((e) => e.type === "added").length;
      const base = { commit: c.commit, subject: c.subject, intent, addedInCommit };

      const follow = (from: EntityRef | undefined) => {
        if (from && !tracked.has(from.name)) {
          tracked.add(from.name);
          names.push(from.name);
        }
      };

      for (const e of events) {
        if (e.type === "ambiguous") {
          const mine = e.candidates?.find((cand) => tracked.has(cand.name));
          if (!mine) continue;
          const link = links.find((l) => l.from.name === e.from?.name && l.to.name === mine.name);
          const step: LineageStep = {
            ...base,
            type: link ? "renamed" : "ambiguous",
            name: mine.name,
            path: mine.path,
            from: e.from,
            candidates: e.candidates,
            score: mine.score,
            tier: 1,
            confirmed: link ? true : undefined,
            blob: blobOf(mine.path),
          };
          steps.push(step);
          tier = 1;
          if (link) follow(e.from);
          else unresolved.push(step);
          continue;
        }
        if (!tracked.has(e.name)) continue;
        steps.push({ ...base, type: e.type, name: e.name, path: e.path, from: e.from, score: e.score, tier: e.tier, blob: blobOf(e.path) });
        if (e.tier === 1) tier = 1;
        if (e.type === "renamed" || e.type === "moved") follow(e.from);
      }
    }
  } finally {
    await cat.close();
  }
  return { name, names, steps, unresolved, tier };
}

export interface WorldVersion {
  branch: string;
  commit: string;
  path: string;
  hash: string;
  start: number;
  end: number;
  body: string;
}

/** The entity as it exists at the tip of every local branch. */
export async function entityWorlds(git: Git, name: string): Promise<WorldVersion[]> {
  const shortName = name.split(".").pop()!;
  const refs = (await git.out(["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"]))
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" ") as [string, string]);

  const cat = new CatFile(git.cwd);
  const versions: WorldVersion[] = [];
  try {
    for (const [branch, commit] of refs) {
      const grep = await git.run(["grep", "-l", "-w", "-F", shortName, commit, "--"], { allowFail: true });
      for (const line of grep.stdout.split("\n").filter(Boolean)) {
        const path = line.slice(commit.length + 1);
        if (!languageOf(path)) continue;
        const content = await cat.text(`${commit}:${path}`);
        if (content === null) continue;
        const e = extractEntities(path, content).find((x) => x.name === name);
        if (e) versions.push({ branch, commit, path, hash: e.hash, start: e.start, end: e.end, body: bodyOf(content, e) });
      }
    }
  } finally {
    await cat.close();
  }
  return versions;
}

/** Find the ambiguous succession a person wants to settle. */
export async function findAmbiguity(git: Git, commit: string, from: string, to: string): Promise<{ from: EntityRef; to: EntityRef } | null> {
  const [c] = await commitsWithNotes(git, [commit], ["--no-walk"]);
  if (!c) return null;
  const cat = new CatFile(git.cwd);
  try {
    const events = await eventsForCommit(git, cat, c.commit, c.parents, c.note);
    for (const e of events) {
      if (e.type !== "ambiguous" || e.from?.name !== from) continue;
      const cand = e.candidates?.find((x) => x.name === to);
      if (cand) return { from: e.from, to: { name: cand.name, path: cand.path } };
    }
    return null;
  } finally {
    await cat.close();
  }
}

export interface Explanation {
  name: string;
  sufficient: boolean;
  /** Steps whose recorded intent can explain the entity. */
  reasons: Array<{ commit: string; type: string; path: string; intent: IntentSummary }>;
  /** Every commit the answer rests on. */
  cites: string[];
  lineage: Lineage;
}

export const BULK_THRESHOLD = 10;
export const MIN_CONFIDENCE = 0.5;

/**
 * Why does an entity exist? Only recorded intents count, and only when they
 * are specific: authored, or inferred with enough confidence from a commit
 * that was not a bulk import. Otherwise the answer is "insufficient".
 */
export async function explainEntity(git: Git, name: string, current?: EngineIdentity): Promise<Explanation> {
  const lineage = await entityLineage(git, name, current);
  const reasons: Explanation["reasons"] = [];
  for (const s of lineage.steps) {
    if (!s.intent || s.type === "ambiguous") continue;
    const specific =
      s.intent.source === "authored" || (s.intent.confidence >= MIN_CONFIDENCE && s.addedInCommit < BULK_THRESHOLD);
    if (specific) reasons.push({ commit: s.commit, type: s.type, path: s.path, intent: s.intent });
  }
  return {
    name,
    sufficient: reasons.length > 0,
    reasons,
    cites: [...new Set(lineage.steps.map((s) => s.commit))],
    lineage,
  };
}
