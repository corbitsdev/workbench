import { existsSync } from "node:fs";
import path from "node:path";

const HUB_API_PREFIXES = ["/api/", "/status", "/openapi.json"];

/**
 * Derive `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` from
 * `DATABASE_URL` when `DATABASE_URL` is set and the individual variables are
 * not, so container and self-hosted deployments only need to set `DATABASE_URL`.
 */
export function populateDbEnvFromDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): void {
  const databaseUrl = env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.trim() === "") return;
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error(`DATABASE_URL is not a valid URL: ${JSON.stringify(databaseUrl)}`);
  }
  env["DB_HOST"] ??= url.hostname;
  env["DB_PORT"] ??= url.port === "" ? "5432" : url.port;
  if (url.username !== "") {
    env["DB_USER"] ??= decodeURIComponent(url.username);
  }
  if (url.password !== "") {
    env["DB_PASSWORD"] ??= decodeURIComponent(url.password);
  }
  const dbName = url.pathname.replace(/^\//, "");
  if (dbName !== "") {
    env["DB_NAME"] ??= dbName;
  }
}

export function isStaticWebRequest(req: Request): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const { pathname } = new URL(req.url);
  if (pathname === "/api") return false;
  return !HUB_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function createStaticWebHandler(distDir: string): (req: Request) => Promise<Response> {
  const root = path.resolve(distDir);
  const indexPath = path.resolve(root, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(`WEB_DIST_DIR has no index.html: ${root}`);
  }

  function resolveAssetPath(pathname: string): string | null {
    try {
      const decoded = decodeURIComponent(pathname);
      if (decoded.includes("\0")) return null;
      const candidate = path.resolve(root, `.${decoded}`);
      if (candidate === root || candidate === indexPath) return indexPath;
      return candidate.startsWith(root + path.sep) ? candidate : null;
    } catch {
      return null;
    }
  }

  return async function serveStaticWeb(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    const candidate = resolveAssetPath(pathname);
    if (candidate !== null && candidate !== indexPath) {
      const file = Bun.file(candidate);
      if (await file.exists()) {
        const cacheControl = pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "public, max-age=0, must-revalidate";
        return new Response(req.method === "HEAD" ? null : file, {
          headers: {
            ...(file.type !== "" ? { "Content-Type": file.type } : {}),
            "Cache-Control": cacheControl,
          },
        });
      }
      if (path.extname(pathname) !== "") {
        return new Response("Not Found", {
          status: 404,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
    }

    const indexFile = Bun.file(indexPath);
    return new Response(req.method === "HEAD" ? null : indexFile, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  };
}

export function withStaticWeb<Server>(
  distDir: string | undefined,
  next: (req: Request, server: Server) => Response | Promise<Response>,
): (req: Request, server: Server) => Response | Promise<Response> {
  const trimmed = distDir?.trim();
  if (trimmed === undefined || trimmed === "") return next;
  const serveStatic = createStaticWebHandler(trimmed);
  return function fetchWithStaticWeb(req: Request, server: Server) {
    if (isStaticWebRequest(req)) return serveStatic(req);
    return next(req, server);
  };
}
