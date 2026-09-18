// The workflow/step ids for Myra's mail-triggered assistant definition, and
// the hub-credential facts a deployer and the definition must agree on.
// Split from the prompt so the prompt module stays prompt-only, and kept
// free of the runtime so a browser can import it.

export const ASSISTANT_WORKFLOW_ID = "wf_assistant";
export const ASSISTANT_STEP_ID = "assistant";

/** The tool packages the hub credential is bound to; also the consumers the
 * credential-use grants are conditioned on. One credential per agent serves
 * both, so each package needs its own binding and its own requirement. */
export const ARTIFACT_TOOLS_PACKAGE = "@corbits/artifacts/sidecar-bundle";
export const MEMORY_TOOLS_PACKAGE = "@corbits/memory/sidecar-bundle";

/** The handle the artifact tools resolve at run time. */
export const HUB_CREDENTIAL_HANDLE = "hub";

/** The provider row standing for the hub itself, one per workbench. */
export const HUB_PROVIDER_NAME = "workbench-hub";

/** The credential name an agent's hub token is stored under; the binding
 * resolves it by this name, so both sides derive it here. */
export function agentHubCredentialName(workflowId: string): string {
  return `${workflowId}-hub`;
}

export type HubCredentialBinding = {
  readonly package: string;
  readonly handle: string;
  readonly provider: string;
  readonly name: string;
  readonly locator: "tenant";
};

export type HubCredentialUseRequirement = {
  readonly resource: string;
  readonly action: "use";
  readonly effect: "allow";
  readonly source: "creator";
  readonly conditions: { readonly tool: string };
};

/** A definition's credential binding: the deploy resolves the named
 * tenant-owned credential into one tool package's `hub` handle. */
function hubCredentialBinding(toolPackage: string, workflowId: string): HubCredentialBinding {
  return {
    package: toolPackage,
    handle: HUB_CREDENTIAL_HANDLE,
    provider: HUB_PROVIDER_NAME,
    name: agentHubCredentialName(workflowId),
    locator: "tenant",
  };
}

/** A definition's grant requirement: at the run's first trigger the hub
 * resolves it against the definition creator's authority and stamps the
 * `credential:{id}` / `use` grant the tools' runtime gate checks, scoped to
 * that one package. The run principal does not exist before then, so this is
 * the only place the grant can be declared. */
function hubCredentialUseRequirement(
  toolPackage: string,
  credentialId: string,
): HubCredentialUseRequirement {
  return {
    resource: `credential:${credentialId}`,
    action: "use",
    effect: "allow",
    source: "creator",
    conditions: { tool: `tool:${toolPackage}` },
  };
}

export function artifactToolsCredentialBinding(workflowId: string): HubCredentialBinding {
  return hubCredentialBinding(ARTIFACT_TOOLS_PACKAGE, workflowId);
}

export function artifactToolsCredentialUseRequirement(
  credentialId: string,
): HubCredentialUseRequirement {
  return hubCredentialUseRequirement(ARTIFACT_TOOLS_PACKAGE, credentialId);
}

export function memoryToolsCredentialBinding(workflowId: string): HubCredentialBinding {
  return hubCredentialBinding(MEMORY_TOOLS_PACKAGE, workflowId);
}

export function memoryToolsCredentialUseRequirement(
  credentialId: string,
): HubCredentialUseRequirement {
  return hubCredentialUseRequirement(MEMORY_TOOLS_PACKAGE, credentialId);
}
