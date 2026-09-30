// A new workbench's first message outlives the /new page: it is parked here
// until the workbench's agent is live and the send lands, so it is never lost.

import { reportError } from "@corbits/error-sink";

const key = (tenantId: string): string => `workbench-opening-message:${tenantId}`;

export function parkOpeningMessage(tenantId: string, text: string): void {
  try {
    sessionStorage.setItem(key(tenantId), text);
  } catch (cause) {
    reportError(cause, { operation: "opening_message_park", tenantId });
  }
}

export function readOpeningMessage(tenantId: string): string | null {
  try {
    return sessionStorage.getItem(key(tenantId));
  } catch (cause) {
    reportError(cause, { operation: "opening_message_read", tenantId });
    return null;
  }
}

export function clearOpeningMessage(tenantId: string): void {
  try {
    sessionStorage.removeItem(key(tenantId));
  } catch (cause) {
    reportError(cause, { operation: "opening_message_clear", tenantId });
  }
}
