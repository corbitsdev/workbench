import { and, eq } from "drizzle-orm";
import {
  composeStyleOverlay,
  myraSurfaceForTemplateKey,
  type StyleAxisSelections,
} from "@workbench/myra";
import { formatSection, promptFormatForProvider } from "@workbench/prompts";
import { readMyraVariantPreference } from "../services/myra-variant-preferences";
import { memberAgentInstance } from "../db/schema";
import type { HubDb } from "../db";

/**
 * Compose the personalization-style prompt section for a Myra instance
 * (chat or triage), or `null` when the instance is not a Myra instance, has
 * no member mapping, or the member's stored selection is entirely default —
 * the byte-identical current-prompt guarantee. `personality` / `emojiUse` /
 * `uiType` are global; the three usage dials read the axis stored for this
 * instance's surface. Rendered as static authored prompt copy (never
 * `formatDataSection` — this is our own curated instruction text, not
 * retrieved/user data), so it is appended AFTER the base prompt and after
 * any operator-identity data section.
 */
export async function composeMyraStyleOverlaySectionForInstance(
  db: HubDb,
  opts: { tenantId: string; instanceId: string; provider: string },
): Promise<string | null> {
  const mapping = await db.query.memberAgentInstance.findFirst({
    where: and(
      eq(memberAgentInstance.tenantId, opts.tenantId),
      eq(memberAgentInstance.instanceId, opts.instanceId),
    ),
  });
  if (!mapping) return null;

  const surface = myraSurfaceForTemplateKey(mapping.templateKey);
  if (!surface) return null;

  const pref = await readMyraVariantPreference(
    db,
    opts.tenantId,
    mapping.memberPrincipalId,
  );

  const selections: StyleAxisSelections =
    surface === "chat"
      ? {
          personality: pref.personality,
          emojiUse: pref.emojiUse,
          uiType: pref.uiType,
          artifactUsage: pref.artifactUsageChat,
          toolUsage: pref.toolUsageChat,
          skillUsage: pref.skillUsageChat,
        }
      : {
          personality: pref.personality,
          emojiUse: pref.emojiUse,
          uiType: pref.uiType,
          artifactUsage: pref.artifactUsageTriage,
          toolUsage: pref.toolUsageTriage,
          skillUsage: pref.skillUsageTriage,
        };

  const overlay = composeStyleOverlay(selections);
  if (overlay === "") return null;

  const format = promptFormatForProvider(opts.provider);
  return formatSection(
    { tag: "personalization-style", content: overlay },
    format,
  );
}
