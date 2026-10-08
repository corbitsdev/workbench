// The hub seeds nothing: before signup it has no tenants for the visitor,
// and after the client's setup the workspace exists with no deployment,
// created by the signed-in principal; the first bench brings the first
// worker. Reloading the app never duplicates either.
import { expect, test } from "bun:test";
import type { Page } from "puppeteer-core";
import { bootBrowserApp, browserGate } from "../lib/browser";
import { startWorkbench } from "../lib/first-run";

const describeBrowser = browserGate(import.meta.path);
const STEP_TIMEOUT = 60_000;

async function waitForText(page: Page, label: string): Promise<void> {
  await page.waitForFunction(`document.body.innerText.includes(${JSON.stringify(label)})`, {
    timeout: STEP_TIMEOUT,
  });
}

async function clickText(page: Page, selector: string, label: string): Promise<void> {
  const script = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((e) => e.textContent.includes(${JSON.stringify(label)}))`;
  await page.waitForFunction(script, { timeout: STEP_TIMEOUT });
  await page.evaluate(`(${script}).click()`);
}

type Probe = { status: number; body: unknown };

// Same-origin fetch from the page, so the session cookie rides along.
async function probe(page: Page, path: string): Promise<Probe> {
  return (await page.evaluate(
    `fetch(${JSON.stringify(path)}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`,
  )) as Probe;
}

function items(body: unknown): Record<string, unknown>[] {
  const list = Array.isArray(body) ? body : ((body as { data?: unknown } | null)?.data ?? []);
  return list as Record<string, unknown>[];
}

type Snapshot = { tenants: Record<string, unknown>[]; deployments: Record<string, unknown>[] };

async function snapshot(page: Page): Promise<Snapshot> {
  const principals = await probe(page, "/api/me/principals");
  expect(principals.status).toBe(200);
  const tenantIds = [...new Set(items(principals.body).map((p) => String(p["tenantId"])))];
  const tenants: Record<string, unknown>[] = [];
  const deployments: Record<string, unknown>[] = [];
  for (const id of tenantIds) {
    const tenant = await probe(page, `/api/tenants/${id}`);
    expect(tenant.status).toBe(200);
    tenants.push(tenant.body as Record<string, unknown>);
    const deps = await probe(page, `/api/tenants/${id}/workflows/deployments`);
    expect(deps.status).toBe(200);
    deployments.push(...items(deps.body));
  }
  return { tenants, deployments };
}

describeBrowser("client setup", () => {
  const app = bootBrowserApp();

  test("the hub seeds nothing and reloads never duplicate setup", async () => {
    const { page } = await app().newPage();
    await page.goto(app().origin, { waitUntil: "networkidle0" });

    // Before signup the hub has nothing for this visitor.
    expect((await probe(page, "/api/me/principals")).status).toBe(401);
    expect((await probe(page, "/api/tenants")).status).toBeOneOf([401, 403, 404]);

    await clickText(page, "button", "Create an account");
    await waitForText(page, "Create your account");
    await page.type("input[type=email]", `alice+${String(Date.now())}@example.com`);
    await page.type("input[type=password]", "correct-horse-battery-staple");
    await page.click("button[type=submit]");

    await waitForText(page, "Choose your AI model");
    await clickText(page, "label", "Anthropic");
    await page.waitForSelector("input[type=password]");
    await page.type("input[type=password]", "sk-ant-placeholder");
    await clickText(page, "button", "Connect");
    await page.waitForSelector("textarea", { timeout: STEP_TIMEOUT });

    // Setup leaves one workspace tenant and no deployment anywhere.
    const setup = await snapshot(page);
    expect(setup.tenants).toHaveLength(1);
    expect(setup.tenants[0]?.["parentId"] ?? null).toBeNull();
    expect(setup.deployments).toHaveLength(0);
    // The stock tenant carries no creator field; the signed-in user's own
    // principal holding owner on it is the client-created proof.
    const mine = items((await probe(page, "/api/me/principals")).body);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.["tenantId"]).toBe(setup.tenants[0]?.["id"]);
    expect(mine[0]?.["kind"]).toBe("user");
    expect(JSON.stringify(mine[0]?.["roles"])).toContain("owner");

    // The first bench carries the first worker.
    await startWorkbench(page, "Summarize what shipped this week");
    await page.waitForFunction(`location.pathname.startsWith("/w/")`, { timeout: STEP_TIMEOUT });
    const benchId = new URL(page.url()).pathname.slice("/w/".length);

    const first = await snapshot(page);
    expect(first.tenants).toHaveLength(2);
    expect(first.tenants.find((t) => t["id"] === benchId)?.["parentId"]).toBe(
      setup.tenants[0]?.["id"],
    );
    expect(first.deployments).toHaveLength(1);
    expect(first.deployments[0]?.["tenantId"]).toBe(benchId);

    for (let i = 0; i < 2; i++) {
      await page.reload({ waitUntil: "networkidle0" });
      // Give the client's setup time to (wrongly) run again.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      const again = await snapshot(page);
      expect(again.tenants.map((t) => t["id"])).toEqual(first.tenants.map((t) => t["id"]));
      // Status moves (pending -> deployed) and a deployment the hub itself
      // failed is retried by design, so assert no second live deployment and
      // that the first one is never replaced out from under us.
      const live = again.deployments.filter(
        (d) => !["failed", "released", "destroy_failed"].includes(String(d["status"])),
      );
      expect(live.length).toBeLessThanOrEqual(1);
      const ids = again.deployments.map((d) => d["id"]);
      expect(ids).toContain(first.deployments[0]?.["id"]);
    }
    await page.close();
  }, 240_000);
});
