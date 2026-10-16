/**
 * Runs every scenario in features/*.feature as an end-to-end test.
 *
 *   - each scenario gets a fresh sandbox (temp HOME, real git, real CLI)
 *   - scenarios or features tagged @wip are reported as todo
 *   - an undefined step fails the scenario with the step text
 */
import { describe, test } from "bun:test";
import { join, resolve } from "node:path";
import "./steps/repository.ts";
import "./steps/assertions.ts";
import "./steps/entities.ts";
import "./steps/search.ts";
import "./steps/merging.ts";
import { loadFeatures, tagsOf } from "./support/gherkin.ts";
import { runStep } from "./support/registry.ts";
import { World } from "./support/world.ts";

const FEATURES_DIR = join(resolve(import.meta.dir, "../.."), "features");
const SCENARIO_TIMEOUT_MS = 60_000;

for (const feature of loadFeatures(FEATURES_DIR)) {
  describe(feature.name, () => {
    for (const pickle of feature.pickles) {
      if (tagsOf(pickle).includes("@wip")) {
        test.todo(pickle.name);
        continue;
      }
      test(
        pickle.name,
        async () => {
          const world = await World.create();
          try {
            for (const s of pickle.steps) await runStep(s, world);
          } finally {
            await world.dispose();
          }
        },
        SCENARIO_TIMEOUT_MS,
      );
    }
  });
}
