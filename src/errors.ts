/** An error caused by how the tool was used; printed without a stack trace. */
export class UserError extends Error {
  override name = "UserError";
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
