# @corbits/echo-workflow

Minimal mail-triggered conversational workflow that echoes each inbound message back verbatim

## Deploy from the npm registry

Once published, deploy this workflow definition to a tenant by name and
version pin:

```
POST /api/tenants/:id/workflows/deployments
{
  "source": { "kind": "registry", "registry": "npm" },
  "entry": "./src/index.ts",
  "pin": "@corbits/echo-workflow@0.0.1",
  "sourceOfferingIds": ["<catalog offering id>", ...],
  "defaultSourceOfferingId": "<catalog offering id>"
}
```

`entry` is the package's `interchange.workflow` module path; `pin` is
`"@corbits/echo-workflow@0.0.1"` or a semver range on the same name. The hub
installs, probes, gates, and freezes the definition from the registry
tarball before creating the deployment.
