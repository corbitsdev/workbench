# Model seeding: current state and upstream inference-discovery

Written in answer to "are we using Interchange's new model discovery to
handle model seeding?" — we are not, and after reviewing what upstream
actually ships under that name, adopting it would not replace what
workbench's seeding does today. This documents the current path, what
upstream's `inference-discovery`/`inference-testing` packages are for, and
why this is a plan rather than a cutover.

## How workbench seeds models and providers today

Everything about "which providers and models a bench knows about" is
curated, hand-authored data, planted through the hub's native catalog HTTP
API — never discovered at runtime:

- **`packages/hub-client/src/catalog-seed-data.ts` (`CATALOG_SEEDS`)** — one
  curated seed per supported credential provider: a provider row (its
  adapter plugin and base URL) and a small hand-picked model set. This is
  what `workbench seed` plants for the operator's anthropic key and what
  onboarding plants for whichever provider a person connects — including
  the OpenRouter PKCE connect
  (see [onboarding-openrouter-connect.md](onboarding-openrouter-connect.md)).
- **`packages/hub-client/src/seed.ts` (`seedCatalog`)** — walks one
  provider's seed
  through `POST /api/tenants/:id/catalog/{model,providers,credentials,offerings}`,
  idempotently. The offering's `capabilities` field (see
  `vendor/intx/types/src/catalog.ts` and
  `vendor/intx/db/src/schema/catalog.ts`) is never set — every offering
  workbench seeds gets `capabilities: []` from the hub's own default.
- **`packages/hub-client/src/credential-test.ts` (`PROVIDER_TEST_CONFIG`)** —
  a second, independent hardcoded table: each provider's free auth-gated
  probe endpoint, used to prove a freshly-entered key works before it is
  ever stored. Its own `probeModel`/`baseURL` fields exist only to build
  that probe request — nothing downstream of the probe reads them.
- **`packages/onboarding/src/complete-credential.ts`** — plants the
  browsable catalog for whichever provider was connected, key paste and
  OpenRouter/Hugging Face connect alike, via that provider's
  `CATALOG_SEEDS` entry, and deploys the default workflow set against that
  same entry's first model (`CATALOG_SEEDS[provider].models[0]`) — the
  one place a provider's default model is named, so the deploy target and
  the catalog it is chosen from can never drift apart. This is also how a
  bench the hub's own sign-in hook could only mark `bench_unseeded` (no
  hub-owned `ANTHROPIC_API_KEY` configured) finishes seeding: the first
  working credential a user connects, through whichever onboarding path
  reaches this function, seeds the bench with that credential's own
  provider.

None of this reads any kind of external or upstream model registry. Every
model/provider name in the codebase is a literal string someone typed in.

## What upstream's inference-discovery/inference-testing packages are

Read at `/Users/thegreataxios/abklabs/interchange/packages/` (upstream, not
vendored into this repo): `inference-discovery`,
`inference-discovery-{anthropic,google-genai,openai}`, and
`inference-testing`. There is no `@intx/inference-catalog` package — it does
not exist upstream or on npm (confirmed via `npm view`).

`@intx/inference-discovery` is **not** a live model/provider discovery
service. Per its own README, it is the runtime for Interchange's internal
"discovery rig": a CLI (`bin/discover`) that makes real, paid calls against
upstream providers to capture fixture bundles proving which
`(provider, model, capability)` tuples actually behave as documented. It
explicitly refuses to run in CI (`assertNotCI`). `@intx/inference-testing`
then replays those captured fixtures in Interchange's own adapter test
suite — it is a deterministic `fetch`-replacement test harness, not
anything workbench would deploy.

The one piece with any seeding-shaped surface is
`@intx/inference-discovery/catalog`, specifically
`catalogCapabilitiesFor(provider, model)`: given a `(provider, model)`
pair, it returns the capability tags (vision, tools, structured output,
etc.) that pair has a _fixture-bearing, captured_ row for in the
`SUPPORT_MATRIX`. That is a natural fit for workbench's currently-empty
offering `capabilities` field — but it answers "what can this known model
do," not "what models exist." It supplies no provider or model catalog of
its own; `SUPPORT_MATRIX` only has entries for whatever Interchange's own
discovery runs have already captured, and callers still name the
`(provider, model)` pair up front.

## Whether workbench should adopt it

Not as a cutover, for three independent reasons:

1. **Wrong problem.** The owner's question was about "model seeding" —
   which providers/models a bench's catalog knows about. Discovery answers
   a narrower, different question (capability tags for a model workbench
   already named), and does so via paid, non-CI, human-triggered capture
   runs against real provider accounts, not a runtime service the hub or
   `workbench seed` could call.
2. **Not consumable without vendoring.** `@intx/inference-discovery` and
   `@intx/inference-testing` are published on npm, but only at `0.2.2` —
   the same pre-folded-model version that is the stated reason every other
   `@intx/*` package in this repo is vendored under `vendor/intx/` rather
   than depended on directly (see `VENDORED.md`). Consuming either package
   today would mean adding two more vendored packages (plus a provider
   probe plugin per provider used) with their own ledger rows and kill
   dates, not a plain npm dependency bump.
3. **No consumer for what it would provide.** The one applicable output,
   `capabilities`, is not read anywhere in `apps/web` or elsewhere in this
   repo today — it is dead data on every seeded offering. Wiring
   `catalogCapabilitiesFor` into `seedCatalog` would populate a field
   nothing displays or filters on, which is exactly the kind of
   speculative plumbing this repo's "no fallbacks, no spread-assembly, cut
   over cleanly" standard argues against building ahead of a real need.

## If this becomes worth doing later

Revisit once both hold: (a) something in `apps/web` or the hub actually
reads/filters on offering `capabilities`, and (b) `@intx/inference-discovery`
has a real npm publish past the folded-model line (or workbench is ready to
vendor it with a ledger row and kill date like everything else in
`vendor/intx/`). At that point, the integration is narrow: call
`catalogCapabilitiesFor(catalogProvider.plugin, catalogModel.canonicalName)`
in `ensureCatalogOffering` (`packages/hub-client/src/seed.ts`) and pass the
result as the offering's `capabilities`. It does not change what models or
providers workbench seeds — that remains curated data, same as
`PROVIDER_TEST_CONFIG` and `catalog-seed-data.ts` are today, since discovery
has no opinion on which models exist, only on what a named model can prove
it does.
