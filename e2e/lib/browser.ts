// Browser e2e harness: boots the hub in-process on a disposable data dir,
// serves the built apps/web bundle from the same origin (the hub itself
// serves no static files), and drives it with puppeteer-core against a
// local Chrome. A UI test file calls `bootBrowserApp()` once and gets a
// fresh page per test via `newPage()`.
import { afterAll, beforeAll, describe } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { dbGate } from "./db-gate";
import { bootHub, type BootedHub } from "./hub";
import { REPO_ROOT } from "./database-url";
import { isWebBuildFresh, writeWebBuildMarker } from "./web-build";

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WEB_DIR = path.join(REPO_ROOT, "apps", "web");
const DIST_DIR = path.join(WEB_DIR, "dist");

export function chromePath(): string | undefined {
  const candidates = [process.env["CHROME_PATH"], DEFAULT_CHROME].filter(
    (p): p is string => p !== undefined && p !== "",
  );
  return candidates.find((p) => existsSync(p));
}

/**
 * `describe` when Chrome and DATABASE_URL are available, else a loud
 * skip locally. CI=true turns either gap into a hard failure.
 */
export function browserGate(label: string): typeof describe {
  if (chromePath() === undefined && process.env["CI"] === "true") {
    throw new Error(`Chrome not found; "${label}" cannot run. Set CHROME_PATH.`);
  }
  const gate = dbGate(process.env["DATABASE_URL"], label);
  if (chromePath() === undefined) {
    process.stderr.write(`${label}: Chrome not found (set CHROME_PATH); suite skipped.\n`);
    return describe.skip;
  }
  return gate;
}

export type BrowserApp = {
  origin: string;
  /** Opens a page that records console errors and uncaught exceptions. */
  newPage: () => Promise<{ page: Page; errors: string[] }>;
};

// One build per process: files in one `bun test e2e` run serially, so the
// first browser suite builds and the rest reuse its dist while the tree is
// unchanged. A stale dist still rebuilds — the marker only matches the tree
// that produced it.
async function ensureWebBuild(): Promise<void> {
  if (isWebBuildFresh(WEB_DIR, REPO_ROOT)) return;
  const proc = Bun.spawn(["bun", "run", "build"], {
    cwd: WEB_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await proc.exited) !== 0) throw new Error("apps/web build failed");
  writeWebBuildMarker(WEB_DIR, REPO_ROOT);
}

/** Registers beforeAll/afterAll that boot and tear down hub + web + Chrome. */
export function bootBrowserApp(): () => BrowserApp {
  let app: BrowserApp | undefined;
  let browser: Browser | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeAll(async () => {
    if (chromePath() === undefined) throw new Error("Chrome not found");
    await ensureWebBuild();

    // Bind first so BASE_URL (Better Auth's trusted origin) names the real port.
    server = Bun.serve({ port: 0, fetch: () => new Response("booting", { status: 503 }) });
  }, 300_000);

  // The in-process sidecar dials the hub's own port back over WebSocket.
  const hub = bootHub({
    baseUrl: () => `http://localhost:${String(server?.port)}`,
    port: () => server?.port ?? 0,
  });

  beforeAll(async () => {
    const executablePath = chromePath();
    if (executablePath === undefined || server === undefined) throw new Error("Chrome not found");
    const origin = `http://localhost:${String(server.port)}`;
    const booted: BootedHub = hub();
    server.reload({
      websocket: booted.websocket as Bun.WebSocketHandler<unknown>,
      fetch: async (req, srv) => {
        const { pathname } = new URL(req.url);
        if (pathname.startsWith("/api") || pathname === "/status") return booted.fetch(req, srv);
        const file = Bun.file(path.join(DIST_DIR, pathname));
        if (pathname !== "/" && (await file.exists())) return new Response(file);
        return new Response(Bun.file(path.join(DIST_DIR, "index.html")));
      },
    });

    // Ubuntu runners block Chrome's user-namespace sandbox via AppArmor.
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: process.env.CI === "true" ? ["--no-sandbox"] : [],
    });
    const launched = browser;
    app = {
      origin,
      newPage: async () => {
        const page = await launched.newPage();
        const errors: string[] = [];
        page.on("console", (msg) => {
          if (msg.type() === "error") errors.push(msg.text());
        });
        page.on("pageerror", (err) => errors.push(String(err)));
        return { page, errors };
      },
    };
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop(true);
  });

  return () => {
    if (app === undefined) throw new Error("bootBrowserApp: app not booted");
    return app;
  };
}
