# Myra ephemeral spike (staging)

Parallel path to production Myra (`agent_instance` + long-lived harness). **Does not change** join provisioning or `PersonalAgentChat`.

## What it proves

- One **shared** workflow deployment per tenant (not one sidecar session per user).
- Each message starts a **workflow run**; the `chat` step runs as **inline inference** (ephemeral `createAgent` on the sidecar, CL-2251).
- Client holds **conversation history** in the trigger payload until durable conversation storage exists.

## Deploy to staging

From repo root (after hub/sidecar images include this commit):

```bash
bun install
bun --env-file=.env.staging run apps/hub/bin/deploy-workflow.ts \
  --kind myra-ephemeral-spike \
  --hub-url "$HUB_URL"
```

Use the same session or service token flow as other workflows (`docs/DEPLOYING_WORKFLOWS.md` / `bun run admin:staging` → Workflows → Push).

## Web UI

Ships with the web app on staging: **Settings → Myra (workflow)** or `/labs/myra-ephemeral`. The docked Myra chat (instance session) is unchanged on other routes.

## Limits (intentional for spike)

- No Myra tool suite (inline steps are reasoning-only).
- One run per message (no `awaitSignal` chat loop yet).
- No server-side thread store.