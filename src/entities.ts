import { createHash } from "node:crypto";

/**
 * Tier 0 entity extraction: functions, classes, methods and types found by
 * declaration patterns and brace or indentation matching. Deterministic and
 * dependency-free. A parser-backed extractor (tree-sitter) can replace this
 * behind the same interface.
 */

export interface Entity {
  /** Methods are qualified: `Class.method`. */
  name: string;
  kind: "function" | "class" | "method" | "type";
  /** 1-based, inclusive. */
  start: number;
  end: number;
  /** Hash of the normalized body with the entity's own name removed: equal across pure renames. */
  hash: string;
}

type Language = "brace" | "python";

const BRACE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "go", "rs"]);

export function languageOf(path: string): Language | undefined {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "py") return "python";
  if (BRACE_EXTENSIONS.has(ext)) return "brace";
  return undefined;
}

const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "else", "do", "try", "with", "new", "typeof", "await",
]);

interface Pattern {
  re: RegExp;
  kind: Entity["kind"];
  /** Capture group holding the name. */
  group: number;
}

// Declarations at any indentation; methods are detected separately inside classes.
const BRACE_PATTERNS: Pattern[] = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/, kind: "function", group: 1 },
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", group: 1 },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, kind: "function", group: 1 },
  { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "type", group: 1 },
  { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/, kind: "type", group: 1 },
  { re: /^\s*(?:export\s+)?(?:enum)\s+([A-Za-z_$][\w$]*)/, kind: "type", group: 1 },
  // Go
  { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, kind: "function", group: 1 },
  { re: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/, kind: "type", group: 1 },
  // Rust
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function", group: 1 },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/, kind: "type", group: 1 },
];

const METHOD = /^\s+(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/;

/** Strip string literals and comments so braces inside them do not count. */
function codeOnly(line: string, state: { block: boolean }): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < line.length) {
    const c = line[i]!;
    const next = line[i + 1];
    if (state.block) {
      if (c === "*" && next === "/") {
        state.block = false;
        i += 2;
      } else i++;
      continue;
    }
    if (quote) {
      if (c === "\\") i += 2;
      else {
        if (c === quote) quote = null;
        i++;
      }
      continue;
    }
    if (c === "/" && next === "/") break;
    if (c === "/" && next === "*") {
      state.block = true;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Find the last line of a brace-delimited body starting at `start` (0-based). */
function braceEnd(lines: string[], start: number): number {
  const state = { block: false };
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    const code = codeOnly(lines[i]!, state);
    for (const c of code) {
      if (c === "{") {
        depth++;
        opened = true;
      } else if (c === "}") depth--;
    }
    if (opened && depth <= 0) return i;
    // Declarations without a body: arrow expressions, type aliases, Go/Rust items without braces.
    if (!opened && i > start + 2) return start;
    if (!opened && /;\s*$/.test(code)) return i;
  }
  return opened ? lines.length - 1 : start;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Last line of a Python block: following lines indented deeper than the header. */
function pythonEnd(lines: string[], start: number): number {
  const base = indentOf(lines[start]!);
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (indentOf(line) <= base) break;
    end = i;
  }
  return end;
}

export function tokens(text: string): string[] {
  return text.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\s\w]/g) ?? [];
}

function bodyHash(body: string, name: string): string {
  const own = name.split(".").pop()!;
  const normalized = tokens(body)
    .map((t) => (t === own ? "§" : t))
    .join(" ");
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

function push(out: Entity[], lines: string[], name: string, kind: Entity["kind"], start: number, end: number): void {
  const body = lines.slice(start, end + 1).join("\n");
  out.push({ name, kind, start: start + 1, end: end + 1, hash: bodyHash(body, name) });
}

function extractBrace(lines: string[]): Entity[] {
  const out: Entity[] = [];
  let skipUntil = -1;
  for (let i = 0; i < lines.length; i++) {
    if (i <= skipUntil) continue;
    const line = lines[i]!;
    for (const p of BRACE_PATTERNS) {
      const m = p.re.exec(line);
      const name = m?.[p.group];
      if (!m || !name || KEYWORDS.has(name)) continue;
      const end = braceEnd(lines, i);
      push(out, lines, name, p.kind, i, end);
      if (p.kind === "class") {
        for (let j = i + 1; j < end; j++) {
          const mm = METHOD.exec(lines[j]!);
          const method = mm?.[1];
          if (!method || KEYWORDS.has(method) || method === "constructor") continue;
          const mEnd = braceEnd(lines, j);
          push(out, lines, `${name}.${method}`, "method", j, mEnd);
          j = mEnd;
        }
      }
      // Top-level declarations own their body; nested functions are part of it.
      if (indentOf(line) === 0) skipUntil = end;
      break;
    }
  }
  return out;
}

function extractPython(lines: string[]): Entity[] {
  const out: Entity[] = [];
  const classes: Array<{ name: string; indent: number; end: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(line);
    if (!m) continue;
    const indent = m[1]!.length;
    const end = pythonEnd(lines, i);
    while (classes.length && (i > classes.at(-1)!.end || indent <= classes.at(-1)!.indent)) classes.pop();
    const owner = classes.at(-1);
    if (m[2] === "class") {
      push(out, lines, m[3]!, "class", i, end);
      classes.push({ name: m[3]!, indent, end });
    } else if (owner) {
      push(out, lines, `${owner.name}.${m[3]}`, "method", i, end);
    } else if (indent === 0) {
      push(out, lines, m[3]!, "function", i, end);
    }
  }
  return out;
}

export function extractEntities(path: string, content: string): Entity[] {
  const lang = languageOf(path);
  if (!lang) return [];
  const lines = content.split("\n");
  const found = lang === "python" ? extractPython(lines) : extractBrace(lines);
  // Keep the first declaration of a name in a file.
  const seen = new Set<string>();
  return found.filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)));
}

export function bodyOf(content: string, e: Pick<Entity, "start" | "end">): string {
  return content.split("\n").slice(e.start - 1, e.end).join("\n");
}

/** Jaccard similarity of token sets, ignoring the entities' own names. */
export function similarity(a: string, aName: string, b: string, bName: string): number {
  const own = (n: string) => n.split(".").pop()!;
  const set = (text: string, name: string) => new Set(tokens(text).filter((t) => t !== own(name)));
  const sa = set(a, aName);
  const sb = set(b, bName);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// ── events ─────────────────────────────────────────────────────────

export interface EntityRef {
  name: string;
  path: string;
}

export interface EntityEvent {
  type: "added" | "modified" | "removed" | "renamed" | "moved" | "ambiguous";
  name: string;
  path: string;
  /** Previous identity for renamed/moved; the removed entity for ambiguous. */
  from?: EntityRef;
  /** For ambiguous: the equally good successors. */
  candidates?: Array<EntityRef & { score: number }>;
  /** 1 for exact body matches. */
  score?: number;
  /** 0 = exact hash, 1 = similarity. */
  tier: 0 | 1;
}

export interface FileVersion {
  path: string;
  content: string;
}

export const LINK_THRESHOLD = 0.6;
export const AMBIGUITY_MARGIN = 0.05;

/**
 * Compare entities before and after a commit across all changed files, so a
 * function moved to another file is linked rather than reported as removed
 * and added.
 */
export function diffEntities(before: FileVersion[], after: FileVersion[]): EntityEvent[] {
  type Item = Entity & { path: string; body: string };
  const collect = (files: FileVersion[]): Item[] =>
    files.flatMap((f) => extractEntities(f.path, f.content).map((e) => ({ ...e, path: f.path, body: bodyOf(f.content, e) })));

  const old = collect(before);
  const neu = collect(after);
  const key = (e: EntityRef) => `${e.path}\0${e.name}`;
  const oldByKey = new Map(old.map((e) => [key(e), e]));
  const newByKey = new Map(neu.map((e) => [key(e), e]));

  const events: EntityEvent[] = [];
  for (const e of neu) {
    const prev = oldByKey.get(key(e));
    if (prev && prev.hash !== e.hash) events.push({ type: "modified", name: e.name, path: e.path, tier: 0 });
  }

  const removed = old.filter((e) => !newByKey.has(key(e)));
  const added = neu.filter((e) => !oldByKey.has(key(e)));

  const scored = removed.map((r) => ({
    r,
    options: added
      .filter((a) => a.kind === r.kind || (a.kind !== "type" && r.kind !== "type"))
      .map((a) => ({ a, score: a.hash === r.hash ? 1 : similarity(r.body, r.name, a.body, a.name) }))
      .filter((o) => o.score >= LINK_THRESHOLD)
      .sort((x, y) => y.score - x.score),
  }));

  const used = new Set<string>();
  const linkedOld = new Set<string>();
  // Strongest links first so each entity is claimed by its best partner.
  for (const { r, options } of scored.sort((x, y) => (y.options[0]?.score ?? 0) - (x.options[0]?.score ?? 0))) {
    const free = options.filter((o) => !used.has(key(o.a)));
    const best = free[0];
    if (!best) continue;
    const rivals = free.filter((o) => best.score - o.score < AMBIGUITY_MARGIN);
    if (rivals.length > 1) {
      events.push({
        type: "ambiguous",
        name: r.name,
        path: r.path,
        from: { name: r.name, path: r.path },
        candidates: rivals.map((o) => ({ name: o.a.name, path: o.a.path, score: round(o.score) })),
        tier: 1,
      });
      linkedOld.add(key(r));
      for (const o of rivals) used.add(key(o.a));
      continue;
    }
    used.add(key(best.a));
    linkedOld.add(key(r));
    events.push({
      type: best.a.name === r.name ? "moved" : "renamed",
      name: best.a.name,
      path: best.a.path,
      from: { name: r.name, path: r.path },
      score: round(best.score),
      tier: best.score === 1 ? 0 : 1,
    });
  }

  for (const a of added) if (!used.has(key(a))) events.push({ type: "added", name: a.name, path: a.path, tier: 0 });
  for (const r of removed) if (!linkedOld.has(key(r))) events.push({ type: "removed", name: r.name, path: r.path, tier: 0 });
  return events;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
