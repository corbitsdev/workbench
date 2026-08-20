// The built-in registrar that exposes every workflow definition a
// tenant can invite as a command: `/echo do the thing` or
// `@echo do the thing` both resolve to the same handler. This module
// knows nothing about folded runs, workbenches, or chat's own storage —
// it depends only on the two narrow seams a host (today, only
// `@corbits/chat`) already has: listing invitable definitions, and
// starting one against a workbench with a raw argument string. That
// keeps `@corbits/commands` itself host-agnostic, matching "apps stay
// generic; packages own the domain" one level down — this package
// owns the command *grammar and dispatch*, not workflow invocation.
import type { CommandDefinition, CommandPlugin } from "./registry";

export interface WorkflowCommandTarget {
  readonly id: string;
  readonly name: string;
}

export interface StartedWorkflowCommand {
  /** The workbench-facing handle the started workflow now answers to. */
  readonly handle: string;
  readonly address: string;
}

export interface WorkflowCommandDeps {
  listInvitableDefinitions(
    tenantId: string,
  ): Promise<readonly WorkflowCommandTarget[]>;
  startWorkflow(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly workbenchId: string;
    readonly definitionId: string;
    readonly args: string;
  }): Promise<StartedWorkflowCommand>;
}

/**
 * Builds the `CommandPlugin` that turns a tenant's invitable workflow
 * definitions into commands, one per definition, named after the
 * definition itself (`echo`, `assistant`, ...) exactly as the invite
 * affordance already names them. Re-derived on every registry lookup —
 * a definition deployed after boot becomes a command on the very next
 * listing, never requiring a re-registration step.
 */
export function createWorkflowCommandPlugin(
  deps: WorkflowCommandDeps,
): CommandPlugin {
  return async ({ tenantId }) => {
    const definitions = await deps.listInvitableDefinitions(tenantId);
    return definitions.map((definition): CommandDefinition => ({
      name: definition.name,
      description: `Start the "${definition.name}" workflow`,
      argumentHint: "[input]",
      handler: async (args, ctx) => {
        const started = await deps.startWorkflow({
          tenantId: ctx.tenantId,
          principalId: ctx.principalId,
          workbenchId: ctx.workbenchId,
          definitionId: definition.id,
          args,
        });
        return {
          type: "workflow-started",
          definitionId: definition.id,
          address: started.address,
          handle: started.handle,
        };
      },
    }));
  };
}
