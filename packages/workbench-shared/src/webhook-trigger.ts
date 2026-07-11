import { type } from "arktype";

// Webhook-triggered workflow runs: a durable per-trigger secret lets
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

// The GET /me/webhook-triggers response: one keyset-paginated page of the
// caller's triggers, newest first, with an opaque cursor for the next page when
// one exists. Never carries a secret.
export const WebhookTriggerListResponseSchema = type({
  items: WebhookTriggerSchema.array(),
  "nextCursor?": "string",
});
export type WebhookTriggerListResponse =
  typeof WebhookTriggerListResponseSchema.infer;

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
