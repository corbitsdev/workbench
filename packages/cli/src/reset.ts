// `workbench reset`: tear down local state — the platform schema and
// the on-disk asset directories `scripts/reset.ts` owns — so the next
// `bun run dev` lands on a virgin onboarding flow. No hub call: unlike
// setup and seed, reset only touches the database and the filesystem
// directly, so it works even when the hub is not running.

export type ResetDeps = {
  runReset: () => Promise<void>;
  log: (line: string) => void;
};

export async function runReset(deps: ResetDeps): Promise<void> {
  deps.log(
    "resetting local state (database schema and on-disk asset state)...",
  );
  await deps.runReset();
  deps.log("");
  deps.log("reset complete. next: bun run dev");
  deps.log(
    "  (or: workbench setup && workbench seed, to reprovision without going through onboarding)",
  );
}
