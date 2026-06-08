# @workbench/workflow-core

Generic workflow orchestration framework for Workbench. Provides the foundation for building extensible workflow systems.

## Architecture

Workflows in Workbench follow a **package-based extensibility model** analogous to Interchange's tool packages:

```
@workbench/workflow-core
├── Registry (discover available workflows)
├── Types (WorkflowType, UserContext)
└── Router (generic workflow HTTP endpoints)

@workbench/gtm-workflows
├── collateral-generation/
├── call-analysis/ (future)
└── competitor-watch/ (future)

@custom-org/workflows (customer-supplied)
├── custom-workflow-1/
└── custom-workflow-2/
```

## Usage

### Register a Workflow

```ts
import { workflowRegistry } from '@workbench/workflow-core';
import { myCustomWorkflow } from '@custom-org/workflows';

// In your hub setup:
workflowRegistry.register(myCustomWorkflow);
```

### Create a Workflow Type

```ts
import type { WorkflowType } from '@workbench/workflow-core';

export const myWorkflow: WorkflowType = {
  kind: 'my-workflow',
  name: 'My Workflow',
  description: 'What this workflow does',
  // Each step declares the credentials it needs and the tools it may use. The
  // workbench binds a tenant credential to each requirement at install time.
  steps: [
    {
      name: 'analyze',
      label: 'Analyze',
      credentialRequirements: [
        { providerName: 'openai-compatible', source: 'tenant', name: 'LLM' },
      ],
      tools: [],
    },
  ],
  inputSchema: {
    /* workflow-specific input schema */
  },
  outputSchema: {
    /* workflow-specific output schema */
  },
};
```

## Design Principles

1. **No Fallbacks** - If a workflow isn't registered, it doesn't exist. No implicit defaults.
2. **Explicit Registration** - Workflows must be explicitly registered before use.
3. **Tenancy-Aware** - All workflows operate within tenant/principal context (Interchange pattern).
4. **Extensible** - Teams can add workflows without modifying core framework.

## Deployment Model

Teams deploying Workbench can:

1. **Use pre-built GTM workflows**

   ```
   hub + @workbench/gtm-workflows
   ```

2. **Extend with custom workflows**

   ```
   hub + @workbench/gtm-workflows + @acme/workflows
   ```

3. **Build entirely custom workflows**
   ```
   hub + @acme/workflows
   ```

No workflow is available unless explicitly deployed and registered.
