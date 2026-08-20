// Honest stubs for the next scale steps. Each throws with a note about
// what has to exist first — never a faked pass.

export const TODO_SCENARIOS: Readonly<Record<string, string>> = {
  "thousand-message-month":
    "1k messages over ~30 compressed virtual days. Needs: batched/parallel " +
    "senders (the runner is currently strictly sequential), timeline " +
    "pagination in the final read (a single GET may not return 1k items), " +
    "and per-day checkpoint metrics instead of one end-of-run pass.",
  "ten-thousand-message-quarter":
    "10k messages, dozens of channels. Needs everything above plus " +
    "channel sharding in the DSL (steps currently target one channel), " +
    "sampled rather than exhaustive drop checking, and DB-side counting " +
    "instead of API timeline reads for volume assertions.",
  "multi-workbench-crossover":
    "Two tenants with shared/federated channels and cross-tenant " +
    "mentions. Needs: channel-share provisioning in the target " +
    "(packages/chat channel-tenancy routes) and per-tenant actor jars.",
  "quality-sampling-ollama":
    "Same scenarios with OLLAMA_BASE_URL set: real model replies so " +
    "routing correctness can assert reply CONTENT (mentioned agent " +
    "echoed the text, host stayed silent), not just delivery. Needs: an " +
    "ollama catalog seed path in bootSimStack and reply-await polling " +
    "in the runner.",
};

export function todoScenario(name: string): never {
  const note = TODO_SCENARIOS[name];
  throw new Error(
    note === undefined
      ? `unknown scenario "${name}"`
      : `scenario "${name}" is a stub, not implemented yet: ${note}`,
  );
}
