import { type } from "arktype";

/**
 * A Myra persona: a named posture mounted on an ephemeral, thread-style
 * session. Every persona shares Myra's core identity and memory wiring (the
 * `core/` modules) and differs only in prompt, rules, and tool posture.
 *
 * - `key`         stable identifier for the persona (e.g. "thread", "mailbox")
 * - `description` what the persona is for, in one line
 * - `systemPrompt` the deploy-ready system prompt for a session on this persona
 * - `toolNames`   the canonical tool loadout the session advertises
 */
export const MyraPersonaSchema = type({
  key: "string",
  description: "string",
  systemPrompt: "string",
  toolNames: "string[]",
});

export type MyraPersona = typeof MyraPersonaSchema.infer;
