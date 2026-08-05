/**
 * A failure the operator can act on. Every error the verbs raise names
 * the exact problem and carries the command or change that fixes it, so
 * a fresh user is never left guessing.
 */
export class CliError extends Error {
  readonly fix: string;

  constructor(problem: string, fix: string, options?: ErrorOptions) {
    super(problem, options);
    this.name = "CliError";
    this.fix = fix;
  }
}

export function isCliError(value: unknown): value is CliError {
  return value instanceof CliError;
}
