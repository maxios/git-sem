import { parseNote, resolveIntent, type EngineIdentity, type Source } from "./artifacts.ts";
import { CatFile } from "./batch.ts";
import { cosine, embed } from "./embed.ts";
import { familyOf, isTestPath, languageOf, type EntityEvent } from "./entities.ts";
import { commitsWithNotes, eventsForCommit } from "./entity-git.ts";
import type { Git } from "./git.ts";

export interface Touch {
  commit: string;
  subject: string;
  event: EntityEvent;
  intent: string | null;
  source: Source | null;
}

export interface Side {
  ref: string;
  tip: string;
  /** Entity name → what this side's commits did to it, newest first. */
  touched: Map<string, Touch[]>;
  /** Intents of every commit on this side, newest first. */
  intents: string[];
  /** Commits on this side that are not indexed yet (events were computed on the fly). */
  pending: string[];
}

async function readSide(git: Git, cat: CatFile, base: string, ref: string, current?: EngineIdentity): Promise<Side> {
  const tip = (await git.resolve(`${ref}^{commit}`)) ?? ref;
  const commits = await commitsWithNotes(git, [`${base}..${tip}`]);
  const touched = new Map<string, Touch[]>();
  const intents: string[] = [];
  const pending: string[] = [];
  for (const c of commits) {
    const records = parseNote(c.note);
    if (!c.note.trim()) pending.push(c.commit);
    const resolved = resolveIntent(records, current);
    const intent = (resolved?.value as { text?: string } | undefined)?.text ?? null;
    if (intent) intents.push(intent);
    for (const event of await eventsForCommit(git, cat, c.commit, c.parents, c.note)) {
      const names = new Set([event.name, event.from?.name, ...(event.candidates ?? []).map((x) => x.name)].filter(Boolean) as string[]);
      for (const name of names) {
        const list = touched.get(name) ?? [];
        list.push({ commit: c.commit, subject: c.subject, event, intent, source: resolved?.source ?? null });
        touched.set(name, list);
      }
    }
  }
  return { ref, tip, touched, intents, pending };
}

export interface Sides {
  base: string;
  a: Side;
  b: Side;
}

export async function readSides(git: Git, a: string, b: string, current?: EngineIdentity): Promise<Sides> {
  const base = await git.out(["merge-base", a, b]);
  const cat = new CatFile(git.cwd);
  try {
    return { base, a: await readSide(git, cat, base, a, current), b: await readSide(git, cat, base, b, current) };
  } finally {
    await cat.close();
  }
}

// ── merge view (F7) ─────────────────────────────────────────────────

export const REDUNDANCY_THRESHOLD = 0.4;

export interface CoTouched {
  name: string;
  a: Array<{ commit: string; type: string; intent: string | null; source: Source | null }>;
  b: Array<{ commit: string; type: string; intent: string | null; source: Source | null }>;
  /** Both sides seem to pursue the same goal; one change may be enough. */
  redundant: boolean;
  similarity: number;
}

const view = (t: Touch) => ({ commit: t.commit, type: t.event.type, intent: t.intent, source: t.source });

/** Only entities both sides touched, with each side's intent. Lookup and Tier 1 only. */
export function coTouched(sides: Sides): CoTouched[] {
  const out: CoTouched[] = [];
  for (const [name, aTouches] of sides.a.touched) {
    const bTouches = sides.b.touched.get(name);
    if (!bTouches) continue;
    const aText = aTouches.map((t) => t.intent ?? t.subject).join("\n");
    const bText = bTouches.map((t) => t.intent ?? t.subject).join("\n");
    const similarity = Math.round(cosine(embed(aText), embed(bText)) * 100) / 100;
    out.push({ name, a: aTouches.map(view), b: bTouches.map(view), redundant: similarity >= REDUNDANCY_THRESHOLD, similarity });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

// ── contradictions (F8) ─────────────────────────────────────────────

export interface Warning {
  kind: "duplicate-definition" | "stale-reference";
  entity: string;
  message: string;
  a: { ref: string; commit: string; path: string };
  b: { ref: string; commit: string; path: string };
}

const DEFINED = new Set(["added", "renamed", "moved"]);

/**
 * Two definitions of one name only compete when they could meet: different
 * files of the same language, both visible outside their file, and neither
 * in tests. A Go type and a TypeScript type with the same name never
 * collide, and neither do two private helpers (#3).
 */
function canCollide(a: EntityEvent, b: EntityEvent): boolean {
  if (a.path === b.path) return false;
  const family = familyOf(a.path);
  if (!family || family !== familyOf(b.path)) return false;
  if (a.exported === false || b.exported === false) return false;
  return !isTestPath(a.path) && !isTestPath(b.path);
}
const GONE = new Set(["removed", "renamed", "moved"]);

function shortName(name: string): string {
  return name.split(".").pop()!;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * git arguments that find commits changing how often `word` appears. `-S` is
 * a plain string match, so it behaves the same on every platform: regex
 * syntax such as `\b` is a GNU extension that macOS's regex library lacks.
 * Word boundaries are checked afterwards in TypeScript.
 */
export function pickaxeArgs(word: string): string[] {
  return ["-S", word];
}

/**
 * Lines that declare `name` (not ones that merely use it): a declaration
 * keyword before it, a Go method receiver, or a class method header that
 * opens its body. Calls such as `  name(x);` never match.
 */
export const DECLARES = (name: string): RegExp => {
  const n = escapeRegExp(name);
  return new RegExp(
    [
      `(^|[^\\w$.])(function\\*?|const|let|var|class|interface|type|enum|def|func|fn|struct|trait)\\s+${n}($|[^\\w$])`,
      `^func\\s*\\([^)]*\\)\\s*${n}\\s*[(\\[]`,
      `^\\s*(?:(?:public|private|protected|static|async|get|set|override)\\s+)*${n}\\s*(?:<[^>]*>)?\\s*\\([^;]*\\{\\s*$`,
    ].join("|"),
  );
};

/**
 * Whether a side still declares `entity` at its tip, in any file of the same
 * language. A safety net under the extractor: if it missed a declaration
 * (#12), check must not claim the side removed something that is still there.
 */
async function stillDeclared(git: Git, tip: string, entity: { name: string; path: string }): Promise<boolean> {
  const family = familyOf(entity.path);
  const name = shortName(entity.name);
  const r = await git.run(["grep", "-n", "-w", "-F", "-e", name, tip, "--"], { allowFail: true });
  const declares = DECLARES(name);
  for (const line of r.stdout.split("\n")) {
    const rest = line.startsWith(`${tip}:`) ? line.slice(tip.length + 1) : line;
    const match = /^(.*?):\d+:(.*)$/.exec(rest);
    if (!match) continue;
    const [, path = "", text = ""] = match;
    if (family && familyOf(path) !== family) continue;
    if (declares.test(text)) return true;
  }
  return false;
}

/** Newest commit on a side whose diff adds a use of `word` as a whole word. */
async function commitUsing(git: Git, base: string, tip: string, word: string): Promise<{ commit: string; path: string } | null> {
  const r = await git.run(["log", "--format=%x1e%H", "--name-only", ...pickaxeArgs(word), `${base}..${tip}`, "--"], { allowFail: true });
  const whole = new RegExp(`(^|[^\\w$])${escapeRegExp(word)}($|[^\\w$])`);
  for (const raw of r.stdout.split("\x1e")) {
    const [commit, ...files] = raw.trim().split("\n").filter(Boolean);
    if (!commit) continue;
    const path = files.find((f) => languageOf(f)) ?? files[0];
    if (!path) continue;
    const added = (await git.run(["diff", "-U0", `${commit}^`, commit, "--", path], { allowFail: true })).stdout;
    if (added.split("\n").some((l) => l.startsWith("+") && !l.startsWith("+++") && whole.test(l.slice(1)))) {
      return { commit, path };
    }
  }
  return null;
}

/**
 * Tier 0 checks for merges that are clean as text but suspect as logic:
 *
 *   duplicate-definition  both sides define the same entity, in different files
 *   stale-reference       one side renames or removes an entity the other
 *                         side still adds uses of
 *
 * Warnings never block: they inform a decision that stays with you.
 */
export async function findContradictions(git: Git, sides: Sides): Promise<Warning[]> {
  const warnings: Warning[] = [];
  const { a, b, base } = sides;

  for (const [name, aTouches] of a.touched) {
    const bTouches = b.touched.get(name);
    if (!bTouches) continue;
    const aDef = aTouches.find((t) => DEFINED.has(t.event.type) && t.event.name === name);
    const bDef = bTouches.find((t) => DEFINED.has(t.event.type) && t.event.name === name);
    if (aDef && bDef && canCollide(aDef.event, bDef.event)) {
      warnings.push({
        kind: "duplicate-definition",
        entity: name,
        message: `${name} is defined in ${aDef.event.path} on ${a.ref} and in ${bDef.event.path} on ${b.ref}; each side assumes it owns ${name}`,
        a: { ref: a.ref, commit: aDef.commit, path: aDef.event.path },
        b: { ref: b.ref, commit: bDef.commit, path: bDef.event.path },
      });
    }
  }

  for (const [gone, kept] of [
    [a, b],
    [b, a],
  ] as const) {
    for (const touches of gone.touched.values()) {
      for (const t of touches) {
        const old = t.event.from ?? (t.event.type === "removed" ? { name: t.event.name, path: t.event.path } : undefined);
        if (!GONE.has(t.event.type) || !old || (t.event.type !== "removed" && old.name === t.event.name)) continue;
        if (warnings.some((w) => w.kind === "stale-reference" && w.entity === old.name)) continue;
        if (await stillDeclared(git, gone.tip, old)) continue;
        const use = await commitUsing(git, base, kept.tip, shortName(old.name));
        if (!use) continue;
        const what = t.event.type === "removed" ? `removes ${old.name}` : `renames ${old.name} to ${t.event.name}`;
        const [goneSide, keptSide] = [
          { ref: gone.ref, commit: t.commit, path: old.path },
          { ref: kept.ref, commit: use.commit, path: use.path },
        ];
        warnings.push({
          kind: "stale-reference",
          entity: old.name,
          message: `${gone.ref} ${what}, but ${kept.ref} adds uses of ${old.name} in ${use.path}`,
          a: gone === a ? goneSide : keptSide,
          b: gone === a ? keptSide : goneSide,
        });
      }
    }
  }
  return warnings;
}
