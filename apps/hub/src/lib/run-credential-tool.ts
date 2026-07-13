import { resolveCredentialRequirement } from "@intx/db";
import type { HubDb } from "../db";
import { KNOWN_TOOLS, isCredentialToolEntry } from "./tool-registry";
import { decryptToolCredentialSecret } from "./credential-crypto";

export async function runCredentialTool(
  db: HubDb,
  tenantId: string,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const entry = KNOWN_TOOLS[toolName];
  if (!entry) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  if (!isCredentialToolEntry(entry)) {
    throw new Error(`Tool ${toolName} is not a credential tool`);
  }

  const resolved = await resolveCredentialRequirement(
    db,
    tenantId,
    { providerName: entry.providerName, source: "tenant" },
    null,
    null,
  );
  if (!resolved) {
    throw new Error(
      `No credential configured for provider: ${entry.providerName}`,
    );
  }

  const providerRow = await db.query.provider.findFirst({
    where: (p, { eq }) => eq(p.id, resolved.providerId),
  });
  const metadata = (providerRow?.metadata ?? {}) as { baseURL?: string };
  const baseURL = metadata.baseURL ?? "";

  const tools = entry.createTools({
    apiKey: decryptToolCredentialSecret(resolved.secret),
    baseURL,
  });
  const tool = tools.find((t) => t.definition.name === toolName);
  if (!tool) {
    throw new Error(`Tool ${toolName} not found in provider package`);
  }
  if (tool.kind !== "string") {
    throw new Error(
      `Tool ${toolName} uses unsupported handler kind: ${tool.kind}`,
    );
  }

  const controller = new AbortController();
  if (signal) {
    signal.addEventListener("abort", () => controller.abort());
  }

  return tool.handler(args, controller.signal);
}
