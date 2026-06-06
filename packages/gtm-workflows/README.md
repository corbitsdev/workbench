# @workbench/gtm-workflows

Pre-built GTM (go-to-market) workflows for Workbench. Convert call transcripts and customer conversations into sales and marketing collateral.

## Workflows

### Collateral Generation

Turn call transcripts into ready-to-use sales collateral:
- **Email** - Personalized follow-up emails
- **LinkedIn Posts** - Social sharing content
- **One-pagers** - Executive summaries
- **Battercards** - Competitive positioning

**Requires**: OpenAI-compatible LLM (tenant-scoped credential)

### Future Workflows

- **Call Analysis** - Extract key insights, objections, outcomes
- **Competitor Watch** - Identify competitor mentions and strategies
- **Customer Health** - Assess customer sentiment and risk

## Usage

### Register in Hub

```ts
import { workflowRegistry } from '@workbench/workflow-core';
import { collateralGenerationWorkflow } from '@workbench/gtm-workflows';

// In hub setup:
workflowRegistry.register(collateralGenerationWorkflow);
```

### Use from API

```bash
# Get available GTM workflows
GET /workflows/types

# Create a collateral-generation workflow
POST /workflows
{
  "workflowKind": "collateral-generation",
  "transcript": "...",
  "source": "paste"
}
```

## Pre-built GTM Workbench

These workflows enable a **pre-built GTM Workbench** product:
- Teams deploy with zero configuration
- Workflows are opinionated but extensible
- Extend with custom workflows as needed

## Creating Custom Workflows

To add your own workflows to the GTM suite:

1. Create a new directory in `src/`
2. Define a WorkflowType
3. Export from `src/index.ts`
4. Register in hub

Example:

```ts
// src/custom-analysis/workflow.ts
import type { WorkflowType } from '@workbench/workflow-core';

export const customWorkflow: WorkflowType = {
  kind: 'custom-analysis',
  name: 'Custom Analysis',
  // ... rest of definition
};
```

```ts
// src/index.ts
export { collateralGenerationWorkflow } from './collateral-generation';
export { customWorkflow } from './custom-analysis';
```
