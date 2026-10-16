import type { EngineIdentity } from "../artifacts.ts";
import type { SemConfig } from "../config.ts";
import { UserError } from "../errors.ts";
import { commandEngine } from "./command.ts";
import { heuristicEngine } from "./heuristic.ts";
import type { Engine } from "./types.ts";

export type { Engine, IntentInput, IntentProposal } from "./types.ts";

export const DEFAULT_PROMPT_VERSION = "intent/v1";

export function resolveEngine(config: SemConfig, cwd: string): Engine {
  switch (config.engine) {
    case "heuristic":
      return heuristicEngine();
    case "command":
      if (!config.command) throw new UserError("sem.engine is 'command' but sem.command is not set");
      if (!config.model) throw new UserError("sem.engine is 'command' but sem.model is not set");
      return commandEngine({
        command: config.command,
        model: config.model,
        promptVersion: config.promptVersion ?? DEFAULT_PROMPT_VERSION,
        tier: config.tier ?? 2,
        cwd,
        timeoutMs: config.timeoutMs,
      });
    default:
      throw new UserError(`unknown sem.engine '${config.engine}' (expected 'heuristic' or 'command')`);
  }
}

export function identityOf(engine: Engine): EngineIdentity {
  return { engine: engine.id, model: engine.model, prompt: engine.promptVersion };
}

/** The Tier 3 engine, or undefined when none is configured. Never used implicitly. */
export function resolveFrontier(config: SemConfig, cwd: string): Engine | undefined {
  const { command, model } = config.frontier;
  if (!command) return undefined;
  if (!model) throw new UserError("sem.frontier.command is set but sem.frontier.model is not");
  return commandEngine({
    id: "frontier",
    command,
    model,
    promptVersion: config.promptVersion ?? DEFAULT_PROMPT_VERSION,
    tier: 3,
    cwd,
    timeoutMs: config.timeoutMs,
  });
}
