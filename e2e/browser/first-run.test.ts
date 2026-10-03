// A fresh user signs up in a real browser, connects a placeholder provider,
// and creates three benches from /new: each is its own child tenant with
// exactly one agent, the sidebar lists them by short title, and no bench's
// thread shows another's opening message. One test, because a third hub boot
// in the same `bun test` process hangs its deploys. Inference is not
// scripted in this harness, so the agent's self-naming reply is not covered.
import { expect, test } from "bun:test";
import type { Page } from "puppeteer-core";
import { bootBrowserApp, browserGate } from "../lib/browser";
import { clickText, STEP_TIMEOUT, waitForText } from "../lib/first-run";

const describeBrowser = browserGate(import.meta.path);
const MESSAGES = [
  "Summarize what shipped this week across every repository we track, grouped by team",
  "Draft a launch checklist for the onboarding redesign including owners and due dates",
  "Research competing pricing pages and list the three patterns we should borrow first",
] as const;

const VIEWPORT = { width: 1400, height: 900 };

type Principal = { tenantId: string; kind: string; status: string };
type Tenant = { id: string; parentId: string | null };

async function hubJson<T>(page: Page, url: string): Promise<T> {
  return (await page.evaluate(`fetch(${JSON.stringify(url)}).then((r) => r.json())`)) as T;
}

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
  await page.type("input[type=password]", "sk-ant-placeholder");
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
});
