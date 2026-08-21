import { type } from "arktype";

export interface CampaignConfig {
  seed: number;
  targetMessages: number;
  checkpoints: readonly number[];
  threadReplyRate: number;
  /** Every Nth say @mentions an agent fire-and-forget: the mention is sent
   * and the campaign moves on without waiting — the agent's turn still
   * runs as real inference server-side, just unmeasured. */
  mentionEvery: number;
  /** Every Nth say becomes a measured turn: a mention is sent to a real
   * agent (real Ollama inference, no stub/noop path) and the campaign
   * waits for that turn to complete, recording its latency. */
  realTurnEvery: number;
  burstEvery: number;
  burstSize: number;
  simDaysPerCheckpointGap: number;
  restartAtMessages: readonly number[];
  providerSwitchAtMessages: readonly number[];
  skillEditAtMessages: readonly number[];
  spawnAgentAtMessages: readonly number[];
}

export const campaignConfig = type({
  seed: "number.integer",
  targetMessages: "number.integer > 0",
  checkpoints: "number.integer[]",
  threadReplyRate: "0 <= number <= 1",
  mentionEvery: "number.integer >= 0",
  realTurnEvery: "number.integer >= 0",
  burstEvery: "number.integer >= 0",
  burstSize: "number.integer >= 0",
  simDaysPerCheckpointGap: "number.integer >= 0",
  restartAtMessages: "number.integer[]",
  providerSwitchAtMessages: "number.integer[]",
  skillEditAtMessages: "number.integer[]",
  spawnAgentAtMessages: "number.integer[]",
});

function assertAscendingFromZero(checkpoints: readonly number[]): void {
  if (checkpoints.length === 0 || checkpoints[0] !== 0) {
    throw new Error(
      "parseCampaignConfig: checkpoints must be non-empty and start at 0",
    );
  }
  for (let i = 1; i < checkpoints.length; i++) {
    const previous = checkpoints[i - 1];
    const current = checkpoints[i];
    if (
      previous === undefined ||
      current === undefined ||
      current <= previous
    ) {
      throw new Error(
        `parseCampaignConfig: checkpoints must be strictly ascending, got ${checkpoints.join(", ")}`,
      );
    }
  }
}

export function parseCampaignConfig(input: unknown): CampaignConfig {
  const result = campaignConfig(input);
  if (result instanceof type.errors) {
    throw new Error(`parseCampaignConfig: ${result.summary}`);
  }
  assertAscendingFromZero(result.checkpoints);
  return result;
}
