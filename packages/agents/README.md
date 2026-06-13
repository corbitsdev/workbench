# @workbench/agents

Agent definitions for GTM Workbench. Each agent exports its launch-time credential requirements, system prompt, and tool configuration. The sidecar imports these to register agents at startup.

## Credential Model

Agent `credentialRequirements` are for Interchange launch-time inference sources. Today Interchange resolves every requirement on an agent definition into an `InferenceSource` before launching or reconnecting a sidecar session. That means this list must only contain providers that the sidecar can build as inference sources, currently `openai-compatible`.

Tool-only providers do not belong in `credentialRequirements`. Examples include `firecrawl`, `granola`, `exa`, `xai`, `reddit`, and `scrapecreators`. Putting one of those providers in an agent template will make Interchange push it to the sidecar as an inference source and can fail launch or reconnect with `Source provider "<provider>" is not registered`.

Use this Workbench split for tool-backed premade agents:

```ts
export const AGENT_CREDENTIAL_REQUIREMENTS = [
  { providerName: 'openai-compatible', source: 'tenant', name: LLM_CREDENTIAL_NAME },
];

export const AGENT_DEPLOY_DESCRIPTOR = {
  credentialProviderNames: ['openai-compatible', 'firecrawl'],
  defaultTools: ['firecrawl_scrape'],
  requiredTools: ['firecrawl_scrape'],
};
```

`credentialProviderNames` is Workbench onboarding metadata. It tells the premade-agent UI which credentials to collect, but it is not written into Interchange agent `credentialRequirements`. The hub tool registry resolves tool credentials at tool execution time and keeps the API key server-side.

## Agents

- **Loop** — research and intelligence agent with Exa search
- **Granola** — meeting note retrieval agent
