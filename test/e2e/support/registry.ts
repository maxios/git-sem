import { CucumberExpression, ParameterTypeRegistry } from "@cucumber/cucumber-expressions";
import type { PickleStep } from "@cucumber/messages";
import type { World } from "./world.ts";

// Step arguments are typed by their cucumber expression at runtime.
type StepFn = (world: World, ...args: any[]) => unknown | Promise<unknown>;

interface StepDefinition {
  source: string;
  expression: CucumberExpression;
  fn: StepFn;
}

const parameterTypes = new ParameterTypeRegistry();
const definitions: StepDefinition[] = [];

/** Register a step. Keywords (Given/When/Then/And) are irrelevant to matching. */
export function step(source: string, fn: StepFn): void {
  definitions.push({ source, expression: new CucumberExpression(source, parameterTypes), fn });
}

export async function runStep(pickleStep: PickleStep, world: World): Promise<void> {
  const text = pickleStep.text;
  const matches = definitions
    .map((d) => ({ d, args: d.expression.match(text) }))
    .filter((m) => m.args !== null);

  if (matches.length === 0) throw new Error(`Undefined step: "${text}"`);
  if (matches.length > 1) {
    throw new Error(`Ambiguous step: "${text}" matches ${matches.map((m) => `"${m.d.source}"`).join(", ")}`);
  }

  const { d, args } = matches[0]!;
  const values = (args ?? []).map((a) => a.getValue(null));
  if (pickleStep.argument?.docString) values.push(pickleStep.argument.docString.content);
  if (pickleStep.argument?.dataTable) values.push(pickleStep.argument.dataTable.rows.map((r) => r.cells.map((c) => c.value)));

  try {
    await d.fn(world, ...values);
  } catch (e) {
    if (e instanceof Error) e.message = `Step failed: "${text}"\n${e.message}`;
    throw e;
  }
}
