// Notifications section seam onto @corbits/preferences' tenant-scoped
// per-principal preference bag: this workbench's tenant id keys the row,
// and one JSON key per workbench — "chat.notifications.<workbenchId>" — holds
// that workbench's choice, so every workbench's preference shares the same row.
import { getPreferences, patchPreferences } from "@corbits/preferences/client";

import type { NotificationPreference } from "./notifications-section";

const DEFAULT_NOTIFICATION_PREFERENCE: NotificationPreference = "all";

function notificationsKey(workbenchId: string): string {
  return `chat.notifications.${workbenchId}`;
}

function isNotificationPreference(
  value: unknown,
): value is NotificationPreference {
  return value === "all" || value === "mentions" || value === "mute";
}

export async function getNotificationPreference(
  tenantId: string,
  workbenchId: string,
): Promise<NotificationPreference> {
  const preferences = await getPreferences(tenantId);
  const stored = preferences[notificationsKey(workbenchId)];
  return isNotificationPreference(stored)
    ? stored
    : DEFAULT_NOTIFICATION_PREFERENCE;
}

export async function setNotificationPreference(
  tenantId: string,
  workbenchId: string,
  value: NotificationPreference,
): Promise<NotificationPreference> {
  const preferences = await patchPreferences(tenantId, {
    [notificationsKey(workbenchId)]: value,
  });
  const stored = preferences[notificationsKey(workbenchId)];
  return isNotificationPreference(stored) ? stored : value;
}
