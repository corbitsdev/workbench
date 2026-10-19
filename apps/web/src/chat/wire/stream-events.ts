// Browser-side wire contract for the run live-progress stream and saved
// inference steps (see docs/chat-wire-contract.md).
import { type } from "arktype";

export const RunStreamStatusSchema = type("'idle' | 'busy' | 'waiting_approval'");
export type RunStreamStatus = typeof RunStreamStatusSchema.infer;

const SnapshotFrame = type({
  type: "'snapshot'",
  status: RunStreamStatusSchema,
  text: "string",
});

const StatusFrame = type({
  type: "'status'",
  status: RunStreamStatusSchema,
});

const StepStartedFrame = type({
  type: "'step.started'",
});

const ReasoningDeltaFrame = type({
  type: "'reasoning.delta'",
  token: "string",
});

const TextDeltaFrame = type({
  type: "'text.delta'",
  token: "string",
});

const StepDoneFrame = type({
  type: "'step.done'",
  "reasoning?": "string",
});

const ToolCallFrame = type({
  type: "'tool.call'",
  callId: "string",
  name: "string",
  arguments: "Record<string, unknown>",
});

const ToolResultFrame = type({
  type: "'tool.result'",
  callId: "string",
  content: "string",
  isError: "boolean",
});

const TurnCommittedFrame = type({
  type: "'turn.committed'",
});

export const RunStreamFrameSchema = SnapshotFrame.or(StatusFrame)
  .or(StepStartedFrame)
  .or(ReasoningDeltaFrame)
  .or(TextDeltaFrame)
  .or(StepDoneFrame)
  .or(ToolCallFrame)
  .or(ToolResultFrame)
  .or(TurnCommittedFrame);
export type RunStreamFrame = typeof RunStreamFrameSchema.infer;

const SavedReasoningPart = type({
  kind: "'reasoning'",
  text: "string",
});

const SavedToolCallPart = type({
  kind: "'tool-call'",
  callId: "string",
  name: "string",
  arguments: "Record<string, unknown>",
});

const SavedToolResultPart = type({
  kind: "'tool-result'",
  callId: "string",
  content: "string",
  isError: "boolean",
});

const SavedErrorPart = type({
  kind: "'error'",
  message: "string",
});

export const SavedTurnPartSchema = SavedReasoningPart.or(SavedToolCallPart)
  .or(SavedToolResultPart)
  .or(SavedErrorPart);
export type SavedTurnPart = typeof SavedTurnPartSchema.infer;

export const SavedInferenceTurnSchema = type({
  id: "string",
  startedAt: "string",
  endedAt: "string | null",
  status: "'running' | 'completed' | 'failed'",
  parts: SavedTurnPartSchema.array(),
});
export type SavedInferenceTurn = typeof SavedInferenceTurnSchema.infer;

export const RunInferenceTurnsSchema = type({
  runId: "string",
  turns: SavedInferenceTurnSchema.array(),
});
export type RunInferenceTurns = typeof RunInferenceTurnsSchema.infer;
