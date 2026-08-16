import type { CommandResult, CommandRunner } from "./command-runner";

export type FakeCommandRunner = CommandRunner & {
  readonly calls: (readonly string[])[];
};

export function createFakeCommandRunner(
  handler: (args: readonly string[]) => Promise<CommandResult>,
): FakeCommandRunner {
  const calls: (readonly string[])[] = [];
  return {
    calls,
    async run(args) {
      calls.push(args);
      return handler(args);
    },
  };
}
