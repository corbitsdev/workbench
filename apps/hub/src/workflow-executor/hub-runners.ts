import type { AgentTool } from '@intx/agent';
import type { HubDb } from '../db';
import { isCredentialToolEntry, KNOWN_TOOLS } from '../lib/tool-registry';
import { runCredentialTool } from '../lib/run-credential-tool';
import { resolveWorkflowDeploySource } from '../services/workflow-deploy-config';
import type { ReasoningRunner, RunState, ToolRunner } from './executor';
import { runReasoningStep } from './inference';
import { createWorkflowAuthorizer, type WorkflowAuthorizer } from './authz';

// The deterministic-step result envelope. The pre-substrate FE (and the panels)
// decode a tool result as `{ content: string }` where content is the
// JSON-stringified tool payload. Credential tools already return a string; we
// wrap it so the panel's `parse*` decoders see the same shape they did under the
// sidecar harness.
function toToolEnvelope(raw: unknown): { content: string } {
  if (typeof raw === 'string') return { content: raw };
  return { content: JSON.stringify(raw) };
}

function localToolName(tool: string): string {
  const separator = tool.lastIndexOf(':');
  return separator === -1 ? tool : tool.slice(separator + 1);
}

// Hub-side tool runner. Credential tools (granola_*) resolve the tenant
// credential and call the provider directly via runCredentialTool. Context
// tools (artifact_create) need hub db + principal/session context, so they are
// instantiated against the run's tenant/principal and invoked in-process. No
// sidecar, no event log.
export function createHubToolRunner(deps: {
  db: HubDb;
  authorizer?: WorkflowAuthorizer;
}): ToolRunner {
  const authorizer = deps.authorizer ?? createWorkflowAuthorizer({ db: deps.db });
  return {
    async run({ tool, input, state }) {
      const dispatchTool = localToolName(tool);
      const entry = KNOWN_TOOLS[dispatchTool];
      if (!entry) throw new Error(`workflow executor: unknown tool "${tool}"`);

      // Gate the invoke exactly as the native sidecar step path does: the run
      // principal must hold a `tool:<name>`/`invoke` allow grant. Runs as the
      // run's persisted principal (state.principalId).
      await authorizer.assertToolGranted(state, tool);

      const args = (typeof input === 'object' && input !== null ? input : {}) as Record<
        string,
        unknown
      >;

      if (isCredentialToolEntry(entry)) {
        const raw = await runCredentialTool(deps.db, state.tenantId, dispatchTool, args);
        return toToolEnvelope(raw);
      }

      // Context tool (e.g. artifact_create). sessionId is the run id; the
      // synthetic per-run principal is the run's principalId. agentId is set to
      // the run id for provenance.
      const tools: AgentTool[] = entry.createTools({
        db: deps.db,
        tenantId: state.tenantId,
        principalId: state.principalId,
        agentId: state.runId,
        sessionId: state.runId,
      });
      const handler = tools.find((t) => t.definition.name === dispatchTool);
      if (!handler) throw new Error(`workflow executor: tool "${tool}" not found in package`);
      if (handler.kind !== 'string') {
        throw new Error(
          `workflow executor: tool "${tool}" handler kind "${handler.kind}" unsupported`
        );
      }
      const raw = await handler.handler(args, new AbortController().signal);
      return toToolEnvelope(raw);
    },
  };
}

// Hub-side reasoning runner. Builds the tenant LLM inference source (the same
// source the deploy path pins) and runs one single-turn `@intx/agent` send with
// no tools. The reply is wrapped as `{ reply }` so the panel decoders match the
// pre-substrate agent-step shape.
export function createHubReasoningRunner(deps: {
  db: HubDb;
  authorizer?: WorkflowAuthorizer;
}): ReasoningRunner {
  const authorizer = deps.authorizer ?? createWorkflowAuthorizer({ db: deps.db });
  return {
    async run({ systemPrompt, input, state }) {
      const sources = await resolveWorkflowDeploySource({
        db: deps.db,
        tenantId: state.tenantId,
      });
      const [source] = sources;
      if (source === undefined) {
        throw new Error(
          `workflow reasoning: no inference source resolved for tenant ${state.tenantId}`
        );
      }
      const userMessage = typeof input === 'string' ? input : JSON.stringify(input ?? {});
      const reply = await runReasoningStep({
        source,
        systemPrompt,
        userMessage,
        authorize: authorizer.authorizeFn(state),
      });
      return { reply };
    },
  };
}

export type { RunState };
