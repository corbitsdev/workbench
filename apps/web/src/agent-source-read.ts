// Reads an existing agent's deploy source back out of its workflow asset,
// so the new-workbench picker can re-push the same definition into a
// child tenant (agent-deploy.ts already generalizes that push+deploy).
// There is no stock file-read route for a workflow asset (only
// package-registry tarballs get one), so this fetches `main` over the
// asset's smart-HTTP git remote with a short-lived read-only token.
import {
  parseWorkflowSourceDefinition,
  WORKFLOW_SOURCE_DEFINITION_PATH,
} from "@corbits/workflows/client";
import { type } from "arktype";

import { fetchSourceFile } from "./git-fetch";

export class AgentSourceReadError extends Error {}

const GitTokenMintShape = type({ id: "string", secret: "string" });

const AgentWorkflowJsonShape = type({
  id: "string",
  steps: type.Record(
    "string",
    type({
      agent: type({
        systemPrompt: "string",
        inference: { sources: type({ provider: "string", model: "string" }).array() },
      }),
    }),
  ),
});

const READ_TOKEN_LIFETIME_MS = 10 * 60 * 1000;

async function readErrorBody(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  const envelope = type({
    error: { code: "string", userMessage: "string", refId: "string" },
  })(body);
  return envelope instanceof type.errors ? `HTTP ${response.status}` : envelope.error.userMessage;
}

/** An existing agent's deploy source, in the shape `deployAgentSource`'s
 * `NewAgentInput` needs plus the sources it declares for inference. */
export type AgentSource = {
  readonly systemPrompt: string;
  readonly declaredSources: readonly { readonly provider: string; readonly model: string }[];
};

/** Mints a read-only token, fetches the asset's `main`, and parses out the
 * agent definition its source tree carries. */
export async function readAgentSource(
  tenantId: string,
  assetId: string,
  assetName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentSource> {
  const tokensPath = `/api/tenants/${encodeURIComponent(tenantId)}/git-tokens`;
  const minted = await fetchImpl(tokensPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `agent-read-${crypto.randomUUID()}`,
      resource: `asset:${assetId}`,
      refPattern: "refs/heads/main",
      actions: ["can_read"],
      expiresAt: new Date(Date.now() + READ_TOKEN_LIFETIME_MS).toISOString(),
    }),
  });
  if (!minted.ok) {
    throw new AgentSourceReadError(`minting a read token failed: ${await readErrorBody(minted)}`);
  }
  const token = GitTokenMintShape(await minted.json());
  if (token instanceof type.errors) {
    throw new AgentSourceReadError(
      `the read token came back an unexpected shape: ${token.summary}`,
    );
  }

  const url = new URL(
    `/api/tenants/${encodeURIComponent(tenantId)}/assets/workflow/${assetName}.git`,
    globalThis.location.origin,
  ).toString();
  try {
    const definitionFile = await fetchSourceFile({
      url,
      token: token.secret,
      filepath: WORKFLOW_SOURCE_DEFINITION_PATH,
    });
    const workflowJson = parseWorkflowSourceDefinition(definitionFile, assetId);
    const parsed = AgentWorkflowJsonShape(JSON.parse(workflowJson));
    if (parsed instanceof type.errors) {
      throw new AgentSourceReadError(
        `this agent's source came back an unexpected shape: ${parsed.summary}`,
      );
    }
    const step = Object.values(parsed.steps)[0];
    if (step === undefined) {
      throw new AgentSourceReadError("this agent's source has no steps to read a prompt from");
    }
    return {
      systemPrompt: step.agent.systemPrompt,
      declaredSources: step.agent.inference.sources,
    };
  } finally {
    await fetchImpl(`${tokensPath}/${encodeURIComponent(token.id)}`, { method: "DELETE" });
  }
}
