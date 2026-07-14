import { randomUUID } from "node:crypto";

export function mintWorkflowRunId(): string {
  return randomUUID();
}
