# Myra page context (CL-3527)

Myra receives a short **page context** block when the web app launches (or relaunches) her instance session. The copy explains what surface the member is on — not live DOM, not inbox rows, and never credentials or PII.

## Contract

| Layer                                         | Responsibility                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/web/src/page-context/catalog.ts`        | Maintained strings and `match(pathname)` per primary route                                   |
| `apps/web/src/page-context/resolve.ts`        | `pageContextForPathname()` — first matching catalog entry wins                               |
| `apps/web/src/hooks/use-myra-session.ts`      | On connect / relaunch recovery, `POST /api/v1/instances/:id/sessions` with `{ pageContext }` |
| `apps/hub/src/routes/agents.ts`               | Validates optional `pageContext` on launch                                                   |
| `apps/hub/src/services/agent-provisioning.ts` | Appends a `page_context` section to the deploy system prompt via `@workbench/prompts`        |

Interchange session launch already ships a composed system prompt on deploy; page context is merged into that prompt at launch time (same pattern as operator personalization), not injected into user mail.

### Idempotent launch

If the instance is already routable on the sidecar, the hub refreshes grants and returns `launched: true` without redeploying. **Page context is applied only when a full launch runs** (cold start, recovery relaunch, or sidecar not yet hosting the address). Navigating while Myra stays connected does not rewrite the running prompt until the next relaunch.

## Adding a new page

1. Register the route in `apps/web/src/router.tsx` (and `NAV_COMMANDS` when it is a top-level nav target).
2. Add a `PageContextEntry` in `catalog.ts`:
   - Put **more specific** paths **above** broader prefixes (e.g. `/artifacts/:id` before `/artifacts`).
   - Write 2–4 sentences: what the user sees, what actions exist, how it differs from neighboring routes.
   - Do not include user names, message bodies, tokens, or environment-specific URLs.
3. Extend `apps/web/src/page-context/page-context.test.ts` with a pathname assertion for the new entry.
4. If the route is a redirect-only alias, no catalog entry is required — the destination route’s context applies after navigation.

## Pages covered

The catalog tracks the protected app shell routes (inbox, chats, artifacts, workflows, skills, settings, admin, owner, insights). Login and pure redirect paths rely on fallback or the post-redirect destination.
