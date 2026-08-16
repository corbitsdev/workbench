export type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export interface CommandRunner {
  run(args: readonly string[]): Promise<CommandResult>;
}

export function createBunCommandRunner(): CommandRunner {
  return {
    async run(args) {
      const child = Bun.spawn(["docker", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        child.stdout.text(),
        child.stderr.text(),
        child.exited,
      ]);
      return { stdout, stderr, exitCode };
    },
  };
}
