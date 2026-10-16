import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "./errors.ts";

interface Usage {
  date: string;
  calls: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Tier 3 calls cost money, so they are counted per day in .git/sem/budget.json
 * and refused once `sem.frontier.dailyBudget` is reached. Tiers 0 to 2 are
 * never counted and keep working.
 */
export async function spendFrontierCall(semDir: string, dailyBudget: number | undefined): Promise<Usage> {
  const file = join(semDir, "budget.json");
  let usage: Usage = { date: today(), calls: 0 };
  try {
    const saved = JSON.parse(await readFile(file, "utf8")) as Usage;
    if (saved.date === today()) usage = saved;
  } catch {
    // no usage yet today
  }
  if (dailyBudget !== undefined && usage.calls >= dailyBudget) {
    throw new UserError(
      `frontier budget exhausted: ${usage.calls}/${dailyBudget} Tier 3 calls used today (sem.frontier.dailyBudget). ` +
        "Tiers 0-2 are unaffected.",
    );
  }
  usage = { date: usage.date, calls: usage.calls + 1 };
  await writeFile(file, JSON.stringify(usage));
  return usage;
}
