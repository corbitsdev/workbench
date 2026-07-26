// Server-side stand-in for @intx/hub-client, wired via tsconfig "paths" (CL-2657).
// The real entry re-exports createBrowserTransport, whose EventSource usage requires
// the DOM lib; this app compiles with lib ESNext like upstream interchange servers.
// Only the type surface the server closure uses is exposed. The Transport interface
// mirrors interchange/packages/hub-client/src/transport.ts; apps/web typechecks the
// real module, so drift surfaces there.
export type {
  InstanceEvent,
  ToolCallEvent,
  MailAddress,
  AgentActivity,
} from "../../../interchange/packages/hub-client/src/types";

// transforms.ts is DOM-free (it imports only @intx/types and ./types), so the
// shim can forward it verbatim. @workbench/agents reaches these through this
// path mapping too — `paths` is compilation-global — so omitting them made
// chat-messages.ts fail to resolve `turnToEvent` in this app only.
export {
  mailToEvent,
  mailDeliveryToEvent,
  turnToEvent,
  parseFromHeader,
  extractBodyText,
  formatAddress,
  isAgentAddress,
  resolveAgentAddress,
  resolveAgentRecipient,
  type MailDeliveryData,
} from "../../../interchange/packages/hub-client/src/transforms";

export interface Transport {
  fetch<T>(method: string, path: string, body?: unknown): Promise<T>;
  subscribe(
    path: string,
    onEvent: (event: unknown) => void,
    opts?: { eventName?: string },
  ): () => void;
}
