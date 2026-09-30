// Three benches created from /new in one session: each is its own child
// tenant with exactly one agent, the sidebar lists them by short title, and
// no bench's thread shows another's opening message. Inference is not
// scripted in this harness, so the agent's self-naming reply is not covered.
import { expect, test } from "bun:test";
import type { Page } from "puppeteer-core";
import { bootBrowserApp, browserGate } from "../lib/browser";

const describeBrowser = browserGate(import.meta.path);
const STEP_TIMEOUT = 60_000;
const MESSAGES = [
  "Summarize what shipped this week across every repository we track, grouped by team",
  "Draft a launch checklist for the onboarding redesign including owners and due dates",
  "Research competing pricing pages and list the three patterns we should borrow first",
] as const;

// Page scripts are strings: this tsconfig has no DOM lib.
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
  await waitForText(page, "Connect a brain");
  await clickText(page, "label", "Anthropic");
  await page.waitForSelector("input[type=password]");
  await page.type("input[type=password]", "sk-ant-placeholder");
  await clickText(page, "button", "Connect");
  await clickText(page, "button", "Start your first workbench");
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
  await page.setViewport(VIEWPORT);
  await signUp(page, origin);
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

  // (b) each bench deploys exactly one agent (one definition asset).
  for (const id of ids) {
    const deployments = await hubJson<{ definitionAssetId: string }[]>(
      page,
      `/api/tenants/${id}/workflows/deployments`,
    );
    expect(new Set(deployments.map((d) => d.definitionAssetId)).size).toBe(1);
  }

  // (c) sidebar: three bench rows with short titles, plus the worker group.
  await page.goto(`${origin}/w/${ids[0]}`, { waitUntil: "networkidle0" });
  await waitForText(page, "Workers");
  const rows = (await page.evaluate(
    `Array.from(document.querySelectorAll(".panel-stack-group")).map((g) => ({ label: g.querySelector(".shell-panel-section-label")?.textContent, names: Array.from(g.querySelectorAll(".shell-ch-name")).map((n) => n.textContent) }))`,
  )) as { label: string; names: string[] }[];
  const benches = rows.find((g) => g.label === "Workbenches")?.names ?? [];
  expect(benches).toHaveLength(3);
  for (const name of benches) expect(name.length).toBeLessThanOrEqual(40);
  expect(rows.find((g) => g.label === "Workers")?.names.length).toBeGreaterThanOrEqual(1);

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

describeBrowser("new bench", () => {
  const app = bootBrowserApp();

  test("three benches from /new are isolated child tenants with one agent each", async () => {
    const { page, errors } = await app().newPage();
    try {
      await runFlow(page, app().origin);
    } catch (cause) {
      const body = await page.evaluate("document.body.innerText");
      process.stderr.write(
        `new-bench failed at ${page.url()}:\n${String(body)}\nconsole: ${errors.join(" | ")}\n`,
      );
      throw cause;
    }
    await page.close();
  }, 420_000);
});
