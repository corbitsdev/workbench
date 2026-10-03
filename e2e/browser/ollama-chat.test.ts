// Bench chat end to end against a real local Ollama provider: sign up,
// connect "Ollama (local)" with a pulled model, create a bench from /new,
// and the worker's reply streams live into the thread (no reload) while
// the bench stops showing "working". Gated on a reachable Ollama with the
// model pulled: OLLAMA_BASE_URL (default http://localhost:11434) and
// OLLAMA_MODEL (default qwen2.5:7b).
import { expect, test } from "bun:test";
import { bootBrowserApp, browserGate } from "../lib/browser";
import { clickText, STEP_TIMEOUT, waitForText } from "../lib/first-run";

const describeBrowser = browserGate(import.meta.path);

const OLLAMA_ORIGIN = process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env["OLLAMA_MODEL"] ?? "qwen2.5:7b";
const OLLAMA_BASE_URL = `${OLLAMA_ORIGIN.replace(/\/+$/, "")}/v1`;

async function ollamaReady(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_ORIGIN.replace(/\/+$/, "")}/api/tags`);
    if (!response.ok) return false;
    const body = (await response.json()) as { models?: { name?: string }[] };
    return (body.models ?? []).some((model) => model.name === OLLAMA_MODEL);
  } catch {
    return false;
  }
}

const PROMPT = "Say hello in one short sentence.";

// The worker's reply row: anything the worker (not me) wrote in the thread.
const OTHER_MESSAGE_SCRIPT = `document.querySelector('.chat-thread-message[data-author="other"]')?.innerText ?? ""`;

describeBrowser("ollama chat", () => {
  const app = bootBrowserApp();

  test("bench chat sends, streams, and receives against local Ollama", async () => {
    if (!(await ollamaReady())) {
      console.warn(
        `ollama chat: skipping live assertions — ${OLLAMA_MODEL} not pulled at ${OLLAMA_ORIGIN} (see docs/local-dev.md).`,
      );
      return;
    }
    const { page, errors } = await app().newPage();
    try {
      await page.goto(app().origin, { waitUntil: "networkidle0" });
      await clickText(page, "button", "Create an account");
      await waitForText(page, "Create your account");
      await page.type("input[type=email]", `ollama+${String(Date.now())}@example.com`);
      await page.type("input[type=password]", "correct-horse-battery-staple");
      await page.click("button[type=submit]");

      // The Ollama option takes a base URL and offers the models the local
      // server reports as pulled — no key anywhere.
      await waitForText(page, "Choose your AI model");
      await clickText(page, "label", "Ollama (local)");
      await page.waitForFunction(
        `Array.from(document.querySelectorAll('select[aria-label="Model"] option')).length > 1`,
        { timeout: STEP_TIMEOUT },
      );
      const currentBase = await page.evaluate(
        `document.querySelector('input[type="url"]')?.value ?? ""`,
      );
      if (currentBase !== OLLAMA_BASE_URL) {
        await page.evaluate(`document.querySelector('input[type="url"]').value = ""`);
        await page.type('input[type="url"]', OLLAMA_BASE_URL);
        await page.waitForFunction(
          `Array.from(document.querySelectorAll('select[aria-label="Model"] option')).some((o) => o.value === ${JSON.stringify(OLLAMA_MODEL)})`,
          { timeout: STEP_TIMEOUT },
        );
      }
      await page.select('select[aria-label="Model"]', OLLAMA_MODEL);
      await page.waitForFunction(
        `Array.from(document.querySelectorAll('button')).some((b) => b.innerText.includes("Connect") && !b.disabled)`,
        { timeout: STEP_TIMEOUT },
      );
      await clickText(page, "button", "Connect");

      await page.waitForSelector("textarea", { timeout: STEP_TIMEOUT });
      await page.type("textarea", PROMPT);
      await page.click("button[aria-label='Start this workbench']");
      await page.waitForFunction(`location.pathname.startsWith("/w/")`, {
        timeout: STEP_TIMEOUT,
      });
      await waitForText(page, PROMPT);

      // The reply streams in live over the mailbox event stream: poll the
      // worker row with no reload, tracking growth as streamed turns land,
      // until the bench stops showing working.
      const lengths: number[] = [];
      const deadline = Date.now() + 480_000;
      let working = true;
      let reply = "";
      while (Date.now() < deadline) {
        reply = (await page.evaluate(OTHER_MESSAGE_SCRIPT)) as string;
        lengths.push(reply.length);
        working = (await page.evaluate(
          `document.body.innerText.toLowerCase().includes("working")`,
        )) as boolean;
        if (!working && reply.trim().length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      const grew = lengths.some((length, index) => index > 0 && length > (lengths[index - 1] ?? 0));
      expect(working).toBe(false);
      expect(reply.trim().length).toBeGreaterThan(0);
      expect(grew).toBe(true);
      expect(reply).not.toMatch(/couldn't reach ollama|not supported|didn't go through/i);

      const url = page.url();
      expect(new URL(url).pathname).toStartWith("/w/");
      // Chromium's own network complaints (a torn-down long-poll under load
      // reports ERR_INCOMPLETE_CHUNKED_ENCODING) are transport noise, not
      // app errors; React warnings and page errors still fail the run.
      const appErrors = errors.filter((e) => !e.includes("favicon") && !e.includes("net::"));
      expect(appErrors).toEqual([]);
    } catch (cause) {
      const body = await page.evaluate("document.body.innerText");
      const reply = await page.evaluate(OTHER_MESSAGE_SCRIPT).catch(() => "<unreadable>");
      process.stderr.write(
        `ollama chat failed at ${page.url()}:\n${String(body)}\nreply: ${String(reply)}\nconsole: ${errors.join(" | ")}\n`,
      );
      throw cause;
    }
    await page.close();
  }, 600_000);
});
