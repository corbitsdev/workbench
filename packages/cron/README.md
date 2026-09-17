# @corbits/cron

Experimental. The vendored Interchange workflow-trigger grammar
(`vendor/intx/workflow/src/definition/triggers.ts`) has no `schedule`
trigger and no scheduler — a workflow can only be launched by `mail`. This
package is the tiny bridge: a tenant saves a cron expression plus a mail
(`to`/`subject`/`body`); `createCronTicker` polls for due schedules and
delivers each as mail through the host's own transport, so a
schedule-triggered workflow is just a `mail`-triggered one addressed at
itself.

- `src/cron.ts` — the 5-field cron grammar (moved from the retired
  `@corbits/workflow-schedule`, unchanged).
- `src/schema.ts` — the `cron.schedule` table (its own Postgres schema, FK'd
  to Interchange's `tenant` table) and its migration.
- `src/ticker.ts` — `createCronTicker({ db, deliver, intervalMs })`: claims
  due rows with `SELECT ... FOR UPDATE SKIP LOCKED` so concurrent tickers
  never double-fire, and only the latest missed tick fires.
- `src/mount.ts` — `mountCron(app, { db, requireTenantMember })`: CRUD at
  `/api/tenants/:tenantId/cron`.

## Mounting in the hub

```ts
const cronApp = new Hono<TenantEnv>();
mountCron(cronApp, {
  db,
  requireTenantMember: (ctx, tenantId) => {
    const c = ctx as { get(key: "tenant"): { id: string } };
    return c.get("tenant").id === tenantId;
  },
});
app.route("/", cronApp);

createCronTicker({
  db,
  intervalMs: 60_000,
  deliver: (message) =>
    lookups.persistMail({
      senderAddress: message.from,
      recipients: message.to,
      raw: buildRawMessage(message),
    }),
}).start();
```
