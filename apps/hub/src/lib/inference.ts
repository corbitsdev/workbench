import { createAgent, defineAgent, createDefaultDirectorRegistry } from '@intx/agent';
import type { InferenceSource } from '@intx/types/runtime';
import type { GrantStore } from '@intx/types/authz';
import type { AuthorizeFn } from '@intx/agent';
import { authorize } from '@intx/authz';
import type { AuthzResult } from '@intx/authz';
import { createIsogitStore } from '@intx/storage-isogit';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function runSingleTurnAgent(
  source: InferenceSource,
  systemPrompt: string,
  userMessage: string,
  contextPrefix: string,
  principalId: string,
  grantStore: GrantStore,
  tenantId: string,
  maxOutputTokens?: number
): Promise<string> {
  const contextDir = join(tmpdir(), `${contextPrefix}-${randomUUID()}`);
  const effectiveSource: InferenceSource =
    maxOutputTokens !== undefined
      ? { ...source, defaults: { ...source.defaults, maxTokens: maxOutputTokens } }
      : source;

  const store = await createIsogitStore(contextDir);

  const authorizeFn: AuthorizeFn = async (resource: string, action: string) => {
    const result: AuthzResult = await authorize(
      grantStore,
      principalId,
      tenantId,
      resource,
      action
    );
    return {
      effect: result.effect,
      matchingGrants: result.matchingGrants,
      resolvedBy: result.resolvedBy,
    };
  };

  const def = defineAgent({
    id: `runSingleTurn-${randomUUID()}`,
    systemPrompt,
    tools: [],
    capabilities: [],
    inference: {
      sources: [{ provider: effectiveSource.provider, model: effectiveSource.model }],
    },
  });

  const env = {
    source: effectiveSource,
    storage: store,
    workdir: contextDir,
    audit: store,
    authorize: authorizeFn,
    directors: createDefaultDirectorRegistry(),
    closeTimeoutMs: 1000,
  };

  const agent = await createAgent(def, env);
  try {
    const result = await agent.send(userMessage);
    return result.reply;
  } finally {
    await agent.close();
  }
}
