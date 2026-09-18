// Mirrored from packages/chat/src (see docs/chat-wire-contract.md, which
// also covers this file's organizing rule).
import { type } from "arktype";
import { Part } from "./parts";

const WorkbenchMessageSender = type({
  name: "string | null",
  address: "string",
});

// Mail headers ride along only when the row was actually mailed; absent,
// never invented, otherwise.
export const ChatMessageEventData = type({
  id: "string",
  workbenchId: "string",
  ref: type({ kind: "'workbench'", id: "string" }),
  createdAt: "string",
  threadId: "string | null",
  sender: WorkbenchMessageSender,
  parts: Part.array(),
  "messageId?": "string",
  "inReplyTo?": "string",
  "references?": "string[]",
});
export type ChatMessageEventData = typeof ChatMessageEventData.infer;

/** The full post-change settings object — never a diff a subscriber
 * would have to fold against state it might not hold yet. */
export const ChatSettingsEventData = type({
  updatedBy: "string",
  settings: "Record<string, unknown>",
});
export type ChatSettingsEventData = typeof ChatSettingsEventData.infer;

export const ChatTypingEventData = type({
  principalId: "string",
});
export type ChatTypingEventData = typeof ChatTypingEventData.infer;

// "offline" fires only once a principal's *last* open connection closes —
// a second open tab never fires it.
export const ChatPresenceEventData = type({
  principalId: "string",
  state: "'online' | 'offline'",
  lastActiveAt: "string",
});
export type ChatPresenceEventData = typeof ChatPresenceEventData.infer;

// Sent only to the connecting stream itself, never broadcast.
export const ChatPresenceSnapshotEventData = type({
  members: type({
    principalId: "string",
    lastActiveAt: "string",
  }).array(),
});
export type ChatPresenceSnapshotEventData = typeof ChatPresenceSnapshotEventData.infer;
