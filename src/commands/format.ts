import type { ArtifactRecord, Source } from "../artifacts.ts";
import { intentText } from "../artifacts.ts";

export function short(hash: string): string {
  return hash.slice(0, 7);
}

/** Wide enough for every kind and source, with a space always after each column. */
const KIND_WIDTH = 13; // "entity-events"
const SOURCE_WIDTH = 8; // "inferred", "authored"

export function provenanceLine(r: ArtifactRecord): string {
  const who = r.author ? ` author=${r.author}` : "";
  return (
    `${r.kind.padEnd(KIND_WIDTH)} ${r.source.padEnd(SOURCE_WIDTH)} engine=${r.engine} model=${r.model} prompt=${r.prompt}` +
    ` tier=${r.tier} confidence=${r.confidence.toFixed(2)}${who} at=${r.createdAt}`
  );
}

export function intentBadge(r: Pick<ArtifactRecord, "source" | "engine" | "model" | "confidence">): string {
  if (r.source === "authored") return "[authored]";
  if (r.engine === "agent") return `[proposed by agent ${r.model} · ${r.confidence.toFixed(2)}]`;
  return `[inferred ${r.model === "none" ? r.engine : r.model} · ${r.confidence.toFixed(2)}]`;
}

export interface IntentView {
  text: string;
  source: Source;
  engine: string;
  model: string;
  prompt: string;
  tier: number;
  confidence: number;
  author?: string;
  createdAt: string;
}

export function intentView(r: ArtifactRecord | undefined): IntentView | null {
  const text = intentText(r);
  if (!r || text === undefined) return null;
  return {
    text,
    source: r.source,
    engine: r.engine,
    model: r.model,
    prompt: r.prompt,
    tier: r.tier,
    confidence: r.confidence,
    author: r.author,
    createdAt: r.createdAt,
  };
}
