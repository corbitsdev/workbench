# @workbench/tools-catalog

Dynamic tool exposure for opt-in agents (Myra). Provides:

- A cheap, factory-free **tool catalog** type (`ToolCatalogEntry`) that describes
  loadable-on-demand tool packages without constructing any tool factory or
  resolving any credential.
- The `search_tools` / `load_tools` catalog tools (`createCatalogTools`) — an
  in-process runner the sidecar harness constructs directly, sharing a mutable
  `ToolExposureState` with the dynamic-tools director.
- Pure, tested search scoring (`searchCatalog`) and load resolution
  (`resolveLoadRequest`).

## Credentials

**Keyless.** `search_tools` and `load_tools` call no external API and require no
credential — there is **no** `seed-credentials.ts` entry and no `.env` var for
this package. They only read the static catalog and mutate an in-process set.

## Wiring

The catalog is passed to both the catalog tools (by direct construction) and the
dynamic-tools director (via `env[DYNAMIC_TOOLS_ENV_KEY]`). `load_tools` adds
names to `ToolExposureState.exposed`; the director advertises
`base ∪ catalog-tools ∪ exposed` on every inference call. Exposure is sticky for
the session. Nothing about which tools are **loaded/dispatchable** changes — only
what is **advertised** to the model.
