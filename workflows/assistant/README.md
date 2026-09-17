# @corbits/assistant-workflow

Mail-triggered conversational workflow with a general-purpose assistant agent

## Deploy from the npm registry

Once published, deploy this workflow definition to a tenant by name and
version pin:

```
POST /api/tenants/:id/workflows/deployments
{
  "source": { "kind": "registry", "registry": "npm" },
  "entry": "./src/index.ts",
  "pin": "@corbits/assistant-workflow@0.0.2",
  "sourceOfferingIds": ["<catalog offering id>", ...],
  "defaultSourceOfferingId": "<catalog offering id>"
}
```

`entry` is the package's `interchange.workflow` module path; `pin` is
`"@corbits/assistant-workflow@0.0.2"` or a semver range on the same name. The hub
installs, probes, gates, and freezes the definition from the registry
tarball before creating the deployment.
