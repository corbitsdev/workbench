import { and, eq } from "drizzle-orm";
import {
  buildInferenceParamsMarker,
  myraSurfaceForTemplateKey,
  resolveMyraVariant,
} from "@workbench/myra";
import { readMyraVariantPreference } from "../services/myra-variant-preferences";
import { memberAgentInstance } from "../db/schema";
import type { HubDb } from "../db";

/**
 * Append the inference-params control-plane marker for a Myra launch (chat or
 * triage), or return the prompt unchanged when not a Myra instance.
 */
export async function appendInferenceParamsMarkerForMyraLaunch(
  db: HubDb,
  opts: { tenantId: string; instanceId: string; systemPrompt: string },
): Promise<string> {
  const mapping = await db.query.memberAgentInstance.findFirst({
    where: and(
      eq(memberAgentInstance.tenantId, opts.tenantId),
      eq(memberAgentInstance.instanceId, opts.instanceId),
    ),
  });
  if (!mapping) return opts.systemPrompt;

  const surface = myraSurfaceForTemplateKey(mapping.templateKey);
  if (!surface) return opts.systemPrompt;

  const pref = await readMyraVariantPreference(
    db,
    opts.tenantId,
    mapping.memberPrincipalId,
  );
  const variant = resolveMyraVariant(
    surface,
    surface === "chat" ? pref.chat : pref.triage,
  );
  const creative = surface === "chat" ? pref.creativeChat : pref.creativeTriage;
  const thinking = surface === "chat" ? pref.thinkingChat : pref.thinkingTriage;

  const marker = buildInferenceParamsMarker({
    model: variant.model,
    creative,
    thinking,
  });
  return `${opts.systemPrompt}\n\n${marker}`;
}
