// First-run journeys sharing one hub boot, in declaration order: the hub
// seeds nothing, signup connects a placeholder provider, three benches
// isolate by tenant, and the composer lays out. One bootBrowserApp for all
// three tests — an extra hub boot in the same `bun test` process risks
// hanging deploys, and every boot multiplies CI minutes. The seed-nothing
// test stays first: it probes the hub before any signup on this boot exists.
// Each test signs up its own user, so tenants never leak across tests.
import { expect, test } from "bun:test";
import type { Page } from "puppeteer-core";
import { bootBrowserApp, browserGate } from "../lib/browser";
import { clickText, STEP_TIMEOUT, waitForText } from "../lib/first-run";

const describeBrowser = browserGate(import.meta.path);

const VIEWPORT = { width: 1400, height: 900 };
// One unbroken token wider than any composer: without wrapping it would force
// a horizontal scrollbar.
const LONG_TOKEN = "a".repeat(400);
const MESSAGES = [
  "Summarize what shipped this week across every repository we track, grouped by team",
  "Draft a launch checklist for the onboarding redesign including owners and due dates",
  "Research competing pricing pages and list the three patterns we should borrow first",
] as const;

type Principal = { tenantId: string; kind: string; status: string };
type Tenant = { id: string; parentId: string | null };
type Probe = { status: number; body: unknown };
type Snapshot = { tenants: Record<string, unknown>[]; deployments: Record<string, unknown>[] };
type RowBox = {
  active: string | null;
  offsetWidth: number;
  containerWidth: number;
  radius: string;
};

async function hubJson<T>(page: Page, url: string): Promise<T> {
  return (await page.evaluate(`fetch(${JSON.stringify(url)}).then((r) => r.json())`)) as T;
}

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

const ROW_BOX_SCRIPT = `(() => {
  const out = [];
  for (const row of document.querySelectorAll(".shell-ch-row")) {
    const parent = row.parentElement;
    out.push({
      active: row.getAttribute("aria-current"),
      offsetWidth: row.offsetWidth,
      containerWidth: parent ? parent.clientWidth : -1,
      radius: getComputedStyle(row).borderTopLeftRadius,
    });
  }
  return out;
})()`;

async function signUp(page: Page, origin: string): Promise<void> {
  await page.goto(origin, { waitUntil: "networkidle0" });
  await clickText(page, "button", "Create an account");
  await waitForText(page, "Create your account");
  await page.type("input[type=email]", `alice+${String(Date.now())}@example.com`);
  await page.type("input[type=password]", "correct-horse-battery-staple");
  await page.click("button[type=submit]");
  await waitForText(page, "Choose your AI model");
  await clickText(page, "label", "Anthropic");
  await page.waitForSelector("input[type=password]");
  await page.type("input[type=password]", "[REDACTED]");
  await clickText(page, "button", "Connect");
}

async function createBench(page: Page, message: string): Promise<string> {
  await page.waitForSelector("textarea", { timeout: STEP_TIMEOUT });
  await page.type("textarea", message);
  await page.click("button[aria-label='Start this workbench']");
  await page.waitForFunction(`location.pathname.startsWith("/w/")`, { timeout: STEP_TIMEOUT });
  await waitForText(page, message);
  return new URL(page.url()).pathname.slice("/w/".length);
}

async function runFlow(page: Page, origin: string): Promise<void> {
  await signUp(page, origin);
  await page.setViewport(VIEWPORT);
  const ids: string[] = [];
  for (const [i, message] of MESSAGES.entries()) {
    if (i > 0) await page.goto(`${origin}/new`, { waitUntil: "networkidle0" });
    ids.push(await createBench(page, message));
  }
  expect(new Set(ids).size).toBe(3);

  // (a) three child tenants under the one workspace, via stock routes.
  const principals = await hubJson<{ data: Principal[] }>(page, "/api/me/principals");
  const tenantIds = principals.data
    .filter((p) => p.kind === "user" && p.status === "active")
    .map((p) => p.tenantId);
  const tenants = await Promise.all(
    tenantIds.map((id) => hubJson<Tenant>(page, `/api/tenants/${id}`)),
  );
  const workspace = tenants.find((t) => t.parentId === null || t.parentId === undefined);
  expect(workspace).toBeDefined();
  const children = tenants.filter((t) => t.parentId === workspace?.id);
  expect(children.map((t) => t.id).sort()).toEqual([...ids].sort());

  // (b) the workspace runs no worker; each bench deploys exactly one agent
  // (one definition asset).
  const workspaceDeployments = await hubJson<unknown[]>(
    page,
    `/api/tenants/${workspace?.id}/workflows/deployments`,
  );
  expect(workspaceDeployments).toHaveLength(0);
  for (const id of ids) {
    const deployments = await hubJson<{ definitionAssetId: string }[]>(
      page,
      `/api/tenants/${id}/workflows/deployments`,
    );
    expect(new Set(deployments.map((d) => d.definitionAssetId)).size).toBe(1);
  }

  // (c) sidebar: three bench rows with short titles.
  await page.goto(`${origin}/w/${ids[0]}`, { waitUntil: "networkidle0" });
  await waitForText(page, "Workbenches");
  const rows = (await page.evaluate(
    `Array.from(document.querySelectorAll(".panel-stack-group")).map((g) => ({ label: g.querySelector(".shell-panel-section-label")?.textContent, names: Array.from(g.querySelectorAll(".shell-ch-name")).map((n) => n.textContent) }))`,
  )) as { label: string; names: string[] }[];
  const benches = rows.find((g) => g.label === "Workbenches")?.names ?? [];
  expect(benches).toHaveLength(3);
  for (const name of benches) expect(name.length).toBeLessThanOrEqual(40);

  // (c2) with several benches, "New worker" asks which one.
  await page.goto(`${origin}/workers`, { waitUntil: "networkidle0" });
  // Radix opens its menu on pointerdown, which `click()` does not send.
  await page.waitForFunction(
    `Array.from(document.querySelectorAll("button[aria-haspopup=menu]")).some((e) => e.textContent.includes("New worker"))`,
    { timeout: STEP_TIMEOUT },
  );
  await page.evaluate(
    `Array.from(document.querySelectorAll("button[aria-haspopup=menu]")).find((e) => e.textContent.includes("New worker")).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))`,
  );
  await page.waitForFunction(`document.querySelectorAll("[role=menuitem]").length === 3`, {
    timeout: STEP_TIMEOUT,
  });

  // (d) no bench shows another's opening message.
  for (const [i, id] of ids.entries()) {
    await page.goto(`${origin}/w/${id}`, { waitUntil: "networkidle0" });
    await waitForText(page, MESSAGES[i] as string);
    const text = (await page.evaluate("document.body.innerText")) as string;
    for (const [j, other] of MESSAGES.entries()) {
      if (j !== i) expect(text.includes(other)).toBe(false);
    }
  }
}

describeBrowser("first run", () => {
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
    await page.type("input[type=password]", "[REDACTED]");
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
    await page.type("textarea", "Summarize what shipped this week");
    await page.click("button[aria-label='Start this workbench']");
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

  test("sign up, connect a provider, create three isolated benches", async () => {
    const { page, errors } = await app().newPage();
    try {
      await runFlow(page, app().origin);
    } catch (cause) {
      const body = await page.evaluate("document.body.innerText");
      process.stderr.write(
        `first-run failed at ${page.url()}:\n${String(body)}\nconsole: ${errors.join(" | ")}\n`,
      );
      throw cause;
    }
    await page.close();
  }, 420_000);

  test("long tokens wrap and sidebar rows go full-width", async () => {
    const { page, errors } = await app().newPage();
    try {
      await page.setViewport(VIEWPORT);
      await page.goto(app().origin, { waitUntil: "networkidle0" });
      await clickText(page, "button", "Create an account");
      await waitForText(page, "Create your account");
      await page.type("input[type=email]", `alice+${String(Date.now())}@example.com`);
      await page.type("input[type=password]", "correct-horse-battery-staple");
      await page.click("button[type=submit]");

      // A placeholder key is enough: connecting stores a credential without
      // calling the provider, and creating a bench needs no inference.
      await waitForText(page, "Choose your AI model");
      await clickText(page, "label", "Anthropic");
      await page.waitForSelector("input[type=password]");
      await page.type("input[type=password]", "[REDACTED]");
      await clickText(page, "button", "Connect");

      // The new-workbench prompt is a bare composer: a long unbroken token
      // must wrap (no horizontal overflow) instead of scrolling.
      await page.waitForSelector(".chat-composer-input", { timeout: STEP_TIMEOUT });
      await page.type(".chat-composer-input", LONG_TOKEN);
      await page.waitForFunction(
        `(() => { const el = document.querySelector(".chat-composer-input"); return el !== null && el.scrollWidth <= el.clientWidth + 1; })()`,
        { timeout: STEP_TIMEOUT },
      );
      const overflowX = (await page.evaluate(
        `getComputedStyle(document.querySelector(".chat-composer-input")).overflowX`,
      )) as string;
      expect(overflowX).toBe("hidden");

      // Create the bench; its sidebar row is populated and active.
      await page.goto(`${app().origin}/new`, { waitUntil: "networkidle0" });
      await page.waitForSelector(".chat-composer-input", { timeout: STEP_TIMEOUT });
      await page.type(".chat-composer-input", "Summarize what shipped this week");
      await page.click("button[aria-label='Start this workbench']");
      await page.waitForFunction(`location.pathname.startsWith("/w/")`, {
        timeout: STEP_TIMEOUT,
      });
      await page.waitForSelector(".shell-ch-row", { timeout: STEP_TIMEOUT });

      const rows = (await page.evaluate(ROW_BOX_SCRIPT)) as RowBox[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Math.abs(row.offsetWidth - row.containerWidth)).toBeLessThanOrEqual(1);
        expect(row.radius).not.toBe("0px");
      }
      expect(rows.some((row) => row.active === "true")).toBe(true);

      // Full-width did not smush the radius: it is stable under hover.
      const hovered = (await page.evaluate(
        `(() => { const row = document.querySelector(".shell-ch-row"); return row === null ? null : getComputedStyle(row).borderTopLeftRadius; })()`,
      )) as string | null;
      await page.hover(".shell-ch-row");
      const hoverRadius = (await page.evaluate(
        `(() => { const row = document.querySelector(".shell-ch-row:hover"); return row === null ? null : getComputedStyle(row).borderTopLeftRadius; })()`,
      )) as string | null;
      expect(hovered).not.toBeNull();
      expect(hoverRadius).toBe(hovered);
    } catch (cause) {
      const body = await page.evaluate("document.body.innerText");
      process.stderr.write(
        `composer-layout failed at ${page.url()}:\n${String(body)}\nconsole: ${errors.join(" | ")}\n`,
      );
      throw cause;
    }
    await page.close();
  }, 240_000);
});
