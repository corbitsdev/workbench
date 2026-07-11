import { type } from "arktype";

// Webhook-triggered workflow runs (CL-3300): a durable per-trigger secret lets
// an external system (Attio, GitHub, Slack, a form) fire a workflow run
// without a session. The plaintext secret is generated at creation, returned
// to its owner exactly once in the create response, and never stored or
// returned again — only its SHA-256 hash persists.

export const WebhookTriggerSchema = type({
  id: "string",
  workflowKind: "string",
  enabled: "boolean",
  createdAt: "string",
  lastFiredAt: "string | null",
});
export type WebhookTrigger = typeof WebhookTriggerSchema.infer;

export const CreateWebhookTriggerBodySchema = type({
  kind: "string > 0",
});
export type CreateWebhookTriggerBody =
  typeof CreateWebhookTriggerBodySchema.infer;

// Returned exactly once, in the 201 create response: the trigger plus its
// plaintext secret. No other route ever returns the secret again.
export const CreateWebhookTriggerResponseSchema = WebhookTriggerSchema.and({
  secret: "string",
});
export type CreateWebhookTriggerResponse =
  typeof CreateWebhookTriggerResponseSchema.infer;
