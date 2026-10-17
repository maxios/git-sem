import { describe, expect, test } from "bun:test";
import { keyOf, type ArtifactRecord } from "../../src/artifacts.ts";
import { isRecomputable, place, superseded } from "../../src/sharing.ts";
import { ENTITIES_VERSION } from "../../src/versions.ts";

function rec(over: Partial<ArtifactRecord>): ArtifactRecord {
  return {
    v: 1,
    kind: "intent",
    object: "c0ffee",
    source: "inferred",
    engine: "command",
    model: "m1",
    prompt: "intent/v1",
    tier: 2,
    confidence: 0.9,
    value: { text: "x" },
    evidence: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const derived = (kind: ArtifactRecord["kind"], prompt: string) => rec({ kind, source: "derived", engine: "core", model: "none", prompt, tier: 0 });
const heuristic = rec({ engine: "heuristic", model: "none", prompt: "heuristic/v1", tier: 0 });
const model = rec({});
const authored = rec({ source: "authored", engine: "human", model: "none", prompt: "none", author: "k@x", tier: 0 });
const agent = rec({ engine: "agent", model: "claude", prompt: "agent/v1" });
const decision = rec({ kind: "decision", source: "derived", engine: "core", model: "none", prompt: "merge/v1", tier: 0 });

describe("what is recomputable (#9)", () => {
  test("derived code facts and heuristic intents are", () => {
    for (const r of [derived("changes", "changes/v1"), derived("file", "file/v1"), derived("entities", ENTITIES_VERSION), derived("entity-events", ENTITIES_VERSION), heuristic]) {
      expect(isRecomputable(r)).toBe(true);
    }
  });

  test("model, agent and authored intents and decisions are not", () => {
    for (const r of [model, authored, agent, decision]) expect(isRecomputable(r)).toBe(false);
  });
});

describe("superseded records", () => {
  test("an older derived format goes only once the current one exists", () => {
    const old = derived("entity-events", "entities/v2");
    expect(superseded([old]).size).toBe(0);
    expect([...superseded([old, derived("entity-events", ENTITIES_VERSION)])]).toEqual([keyOf(old)]);
  });

  test("a heuristic intent goes once any better intent exists", () => {
    expect(superseded([heuristic]).size).toBe(0);
    for (const better of [model, authored, agent]) expect([...superseded([heuristic, better])]).toEqual([keyOf(heuristic)]);
  });

  test("intents from models, agents and people are never superseded", () => {
    const later = rec({ model: "m2" });
    expect(superseded([model, later, authored, agent]).size).toBe(0);
  });
});

describe("place", () => {
  const all = [derived("changes", "changes/v1"), derived("entity-events", "entities/v2"), derived("entity-events", ENTITIES_VERSION), heuristic, model, decision];

  test("by default only judgment and model time are shared", () => {
    const p = place(all);
    expect(p.shared).toEqual([model, decision]);
    expect(p.local.map((r) => r.kind)).toEqual(["changes", "entity-events"]);
    expect(p.dropped.map((r) => r.prompt).sort()).toEqual(["entities/v2", "heuristic/v1"]);
  });

  test("sem.share=derived shares derived records too, but still drops superseded ones", () => {
    const p = place(all, { shareDerived: true });
    expect(p.local).toEqual([]);
    expect(p.shared.map((r) => r.kind)).toEqual(["changes", "entity-events", "intent", "decision"]);
    expect(p.dropped).toHaveLength(2);
  });
});
