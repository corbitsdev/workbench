// A manual trigger through the stock trigger route (what the Routines page's
// Run now calls) answers 202 and the run shows up in the stock runs listing.
// The harness has no scripted inference and no deployed non-agent workflow,
// so Myra's own deployment is the only thing triggerable and the brief +
// artifact half is not asserted.
import { expect, test } from "bun:test";
import { bootBrowserApp, browserGate } from "../lib/browser";
import { runFirstRunFlow } from "../lib/first-run";

const describeBrowser = browserGate(import.meta.path);

// Runs in the page so the signed-in session cookie applies.
const TRIGGER_SCRIPT = `(async () => {
  const bench = decodeURIComponent(location.pathname.split("/")[2]);
  const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
  const benchTenant = await json(await fetch("/api/tenants/" + bench));
  const tenants = [bench, benchTenant.body?.parentId].filter(Boolean);
  // Myra deploys asynchronously after setup, so poll for the deployment.
  for (let attempt = 0; attempt < 60; attempt++) {
    for (const tenantId of tenants) {
      const listed = await json(await fetch("/api/tenants/" + tenantId + "/workflows/deployments"));
      const deployment = (Array.isArray(listed.body) ? listed.body : []).find((d) => d.status === "deployed");
      if (!deployment) continue;
      const base = "/api/tenants/" + tenantId + "/workflows/";
      const trigger = await json(await fetch(base + encodeURIComponent(deployment.id) + "/mail", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Run now" }),
      }));
      const runs = await json(await fetch(base + "runs?limit=50"));
      return { tenantId, deploymentId: deployment.id, trigger, runs };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { tenants, lastListing: null };
})()`;

describeBrowser("run now", () => {
  const app = bootBrowserApp();

  test("a manual trigger is accepted and the run is listed", async () => {
    const { page, errors } = await app().newPage();
    try {
      await runFirstRunFlow(page, app().origin);
      const result = (await page.evaluate(TRIGGER_SCRIPT)) as {
        deploymentId?: string;
        trigger?: { status: number; body: { runId?: string } | null };
        runs?: { body: unknown };
      };
      process.stderr.write(`${JSON.stringify(result)}\n`);
      expect(result.deploymentId).toBeDefined();
      expect(result.trigger?.status).toBe(202);
      expect(typeof result.trigger?.body?.runId).toBe("string");
      expect(JSON.stringify(result.runs?.body)).toContain(result.trigger?.body?.runId ?? "");
    } catch (cause) {
      process.stderr.write(`run-now failed at ${page.url()}\nconsole: ${errors.join(" | ")}\n`);
      throw cause;
    }
    await page.close();
  }, 240_000);
});
