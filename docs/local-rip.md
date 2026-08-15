# The local rip

A "local rip" is the whole platform proof, run by hand on your own
machine, with your own real key: sign up, get a personal bench, connect a
real inference provider, and watch a working workbench come up in front of
you — nothing mocked, nothing skipped. `scripts/e2e/local-rip.test.ts`
proves the same path with a stubbed provider probe and a scratch database
(see its own header comment); this doc is the honest, no-shortcuts version
for a person, not CI.

This first pass covers onboarding → connect only: sign-up through a fully
connected bench. It stops short of proving a task end to end — that leg
lands once CL-6049's task work merges, and will extend this same
walkthrough rather than replace it.

## Prerequisites

- [Bun](https://bun.sh) >= 1.2
- A local [Postgres](https://www.postgresql.org) 17 with pgvector — see
  [README.md](../README.md#running-locally) for the `brew install` line
- `git` on your `PATH` — the onboarding connect flow pushes the default
  workflow definitions into the hub over git smart-HTTP
  (`packages/hub-client/src/workflow-push.ts`'s `createGitWorkflowPusher`
  shells out to the system `git` binary; it fails loud with an install
  hint if `git` isn't found)
- A real API key for the provider you want to connect (this walkthrough
  uses OpenRouter's OAuth connect, which needs no key of your own to
  paste — see below — but any of the providers in
  [`packages/hub-client/src/catalog-seed-data.ts`](../packages/hub-client/src/catalog-seed-data.ts)
  works the same way with a pasted key)

## 1. Bring up a clean stack

```sh
cp .env.example .env
bun run reset   # only if you have a previous local-rip's state lying around
bun run dev
```

`bun run reset` drops the schema and every on-disk asset directory
`bun run dev`/`bun run setup`/`bun run seed` created — skip it on a
genuinely fresh checkout. `bun run dev` validates `.env`, confirms
`DATABASE_URL` is reachable, applies pending migrations, builds the web
UI, seeds the administrator account, and starts the hub, one sidecar, and
the web dev server together (see [README.md](../README.md#running-locally)
for exactly what it checks). Leave `ANTHROPIC_API_KEY` unset in `.env` for
this walkthrough — the point is proving a bench with no hub-owned seed
model gets fully seeded through a person's own connected credential, not
through the operator's key.

Once `bun run dev` reports the hub and web server up, open
`http://localhost:3000` (or whatever `BASE_URL`/`PORT` you set in `.env`).

## 2. Sign up

The app root renders the sign-in screen when you're not authenticated
(`apps/web/src/app.tsx`'s `<AuthScreen>`); toggle it to sign-up and create
an account with any email/password. `WORKBENCH_SIGNUP` defaults to
`closed` — `bun run dev` forces it `open` for the duration of the dev
process regardless of what `.env` says (unless `.env` sets it explicitly),
so self-serve sign-up works out of the box here. On a deployed hub with no
override, the same sign-up attempt is refused at `POST /api/auth/sign-up/email`
with `signup_closed` — `scripts/e2e/local-rip.test.ts`'s first hop proves
exactly that response.

## 3. Name your bench

Signing up lands you on `/onboarding`. Submitting the "Create your
workbench" name form calls `POST /api/onboarding/provision` with that name,
which mints your personal bench through the platform's native
tenant-creation route. With no `ANTHROPIC_API_KEY` configured, the response
reports the bench as provisioned but unseeded (`seeded: false`, with a
`seedSkipReason` naming why) — the UI keeps you on the credential step
rather than pretending you're done.

## 4. Connect a provider

The credential step offers a "Connect with OpenRouter" button (PKCE OAuth,
no client id or secret needed — OpenRouter's connect works with zero extra
config) alongside a paste-a-key form for any provider in
`CREDENTIAL_PROVIDERS` (`apps/web/src/onboarding.ts`), Anthropic included.
Either path:

1. proves your key or exchanged token with a real, free call against the
   provider's own auth-gated endpoint (`testProviderCredential` —
   `packages/hub-client/src/credential-test.ts`) before storing anything;
2. plants it as a credential on your bench alongside that provider's
   curated model catalog;
3. deploys and (unlike the OAuth callback's own fast half) confirms every
   default workflow the platform ships — see the note below on the one
   default workflow this currently can't finish.

Expect the page to show a short "setting up your workbench" wait while
`/complete-setup` polls, then land on a "Your first routines are running"
screen listing each routine as confirmed running with your credential, and
a "Meet Myra" button into the bench itself.

### A known gap: the assistant routine

As of this writing, the **assistant** default workflow does not finish
deploying: it pins the `@corbits/memory-tools` tool package
(`workflows/assistant/src/index.ts`), and that pin only resolves once an
operator has published a `package-registry`-kind asset named
`corbits-tools` carrying its tarball (see `apps/hub/src/index.ts`'s
`CORBITS_TOOLS_REGISTRY` comment). No such asset exists in a fresh
checkout, and nothing in this repo publishes one yet — building that
packaging pipeline (which also needs `@intx/agent`'s and `@intx/types`'s
own dependency closures packaged as real npm tarballs) is real,
substantial work of its own, tracked separately from this walkthrough.
Expect the **echo** and **channel-digest** routines to come up live and
the **assistant** routine to show as failed-to-deploy until that gap is
closed; `scripts/e2e/local-rip.test.ts` asserts this exact, documented
condition rather than a false "fully seeded."

## 5. Check the Connections surface

Back in Settings → Connections, the provider you connected shows as
`connected`, cross-referenced from your tenant's own credentials list
(`GET /api/tenants/:id/credentials`) the same way
`packages/settings-ui/src/connections-status.ts`'s `connectorStatus`
does — the credential named `<provider>-default`
(`inferenceCredentialName`, `packages/hub-client/src/seed.ts`), `status:
"active"`.

That's the onboard → connect leg, proven with your own real key end to
end. Phase B picks up from here once the task leg lands.
