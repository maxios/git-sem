import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AstBuilder, compile, GherkinClassicTokenMatcher, Parser } from "@cucumber/gherkin";
import { IdGenerator, type Pickle } from "@cucumber/messages";

export interface LoadedFeature {
  file: string;
  name: string;
  pickles: readonly Pickle[];
}

/**
 * Parse a .feature file and compile it to pickles: one executable scenario
 * each, with Background steps prepended, Scenario Outlines expanded and tags
 * inherited from the feature.
 */
export function loadFeature(path: string): LoadedFeature {
  const newId = IdGenerator.uuid();
  const parser = new Parser(new AstBuilder(newId), new GherkinClassicTokenMatcher());
  const document = parser.parse(readFileSync(path, "utf8"));
  return {
    file: path,
    name: document.feature?.name ?? path,
    pickles: compile(document, path, newId),
  };
}

export function loadFeatures(dir: string): LoadedFeature[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".feature"))
    .sort()
    .map((f) => loadFeature(join(dir, f)));
}

export function tagsOf(pickle: Pickle): string[] {
  return pickle.tags.map((t) => t.name);
}
