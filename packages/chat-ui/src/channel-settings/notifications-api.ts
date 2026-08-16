// Notifications section seam onto @corbits/preferences' tenant-scoped
// per-principal preference bag: this workbench's tenant id keys the row,
// and one JSON key per channel — "chat.notifications.<channelId>" — holds
// that channel's choice, so every channel's preference shares the same row.
import { getPreferences, patchPreferences } from "@corbits/preferences/client";

import type { NotificationPreference } from "./notifications-section";

const DEFAULT_NOTIFICATION_PREFERENCE: NotificationPreference = "all";

function notificationsKey(channelId: string): string {
  return `chat.notifications.${channelId}`;
}

function isNotificationPreference(
  value: unknown,
): value is NotificationPreference {
  return value === "all" || value === "mentions" || value === "mute";
}

export async function getNotificationPreference(
  tenantId: string,
  channelId: string,
): Promise<NotificationPreference> {
  const preferences = await getPreferences(tenantId);
  const stored = preferences[notificationsKey(channelId)];
  return isNotificationPreference(stored)
    ? stored
    : DEFAULT_NOTIFICATION_PREFERENCE;
}

export async function setNotificationPreference(
  tenantId: string,
  channelId: string,
  value: NotificationPreference,
): Promise<NotificationPreference> {
  const preferences = await patchPreferences(tenantId, {
    [notificationsKey(channelId)]: value,
  });
  const stored = preferences[notificationsKey(channelId)];
  return isNotificationPreference(stored) ? stored : value;
}
