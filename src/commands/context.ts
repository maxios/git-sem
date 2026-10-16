import type { EngineIdentity } from "../artifacts.ts";
import type { Git } from "../git.ts";
import { readConfig } from "../config.ts";
import { identityOf, resolveEngine } from "../engines/index.ts";
import type { Repo } from "../repo.ts";

/**
 * The identity of the configured engine, used to prefer its results when
 * reading. Read commands never invoke the engine, so a misconfigured engine
 * only means "no preference" here.
 */
export async function currentIdentity(repo: Repo): Promise<EngineIdentity | undefined> {
  try {
    return identityOf(resolveEngine(await readConfig(repo.git), repo.root));
  } catch {
    return undefined;
  }
}

/** Who to record as the author of an authored intent: user.email, else user.name. */
export async function authorOf(git: Git): Promise<string> {
  const email = (await git.run(["config", "user.email"], { allowFail: true })).stdout.trim();
  if (email) return email;
  return (await git.run(["config", "user.name"], { allowFail: true })).stdout.trim() || "unknown";
}
