// The workflow/step ids for Myra's mail-triggered assistant definition, and
// the hub-credential facts a deployer and the definition must agree on.
// Split from the prompt so the prompt module stays prompt-only, and kept
// free of the runtime so a browser can import it.

export const ASSISTANT_WORKFLOW_ID = "wf_assistant";
export const ASSISTANT_STEP_ID = "assistant";

/** The tool package the hub credential is bound to; also the consumer the
 * credential-use grant is conditioned on. */
export const ARTIFACT_TOOLS_PACKAGE = "@corbits/artifacts/sidecar-bundle";

/** The handle the artifact tools resolve at run time. */
export const HUB_CREDENTIAL_HANDLE = "hub";

/** The provider row standing for the hub itself, one per workbench. */
export const HUB_PROVIDER_NAME = "workbench-hub";

/** The credential name an agent's hub token is stored under; the binding
 * resolves it by this name, so both sides derive it here. */
export function agentHubCredentialName(workflowId: string): string {
  return `${workflowId}-hub`;
}

/** The definition's credential binding: the deploy resolves the named
 * tenant-owned credential into the artifact tools' `hub` handle. */
export function artifactToolsCredentialBinding(workflowId: string): {
  readonly package: string;
  readonly handle: string;
  readonly provider: string;
  readonly name: string;
  readonly locator: "tenant";
} {
  return {
    package: ARTIFACT_TOOLS_PACKAGE,
    handle: HUB_CREDENTIAL_HANDLE,
    provider: HUB_PROVIDER_NAME,
    name: agentHubCredentialName(workflowId),
    locator: "tenant",
  };
}

/** The definition's grant requirement: at the run's first trigger the hub
 * resolves it against the definition creator's authority and stamps the
 * `credential:{id}` / `use` grant the artifact tools' runtime gate checks,
 * scoped to that one package. The run principal does not exist before
 * then, so this is the only place the grant can be declared. */
export function artifactToolsCredentialUseRequirement(credentialId: string): {
  readonly resource: string;
  readonly action: "use";
  readonly effect: "allow";
  readonly source: "creator";
  readonly conditions: { readonly tool: string };
} {
  return {
    resource: `credential:${credentialId}`,
    action: "use",
    effect: "allow",
    source: "creator",
    conditions: { tool: `tool:${ARTIFACT_TOOLS_PACKAGE}` },
  };
}
