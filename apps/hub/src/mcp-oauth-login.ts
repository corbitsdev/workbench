import {
  buildAuthorizeUrl,
  discoverMcpLoginEntry,
  exchangeCode,
  generatePkce,
  generateState,
  mcpClientConfig,
  OAuthDiscoveryError,
  registerMcpClient,
  startCallbackServer,
  type CallbackServer,
  type FetchLike,
  type McpLoginEntry,
} from "@corbits/oauth-core";
import { createLoginStore, type LoginState } from "@corbits/oauth-core/hub";
import type { DB } from "@intx/db";
import { credential, grant as grantTable } from "@intx/db/schema";
import { generateId } from "@intx/hub-common";
import type { TenantEnv } from "@intx/hub-api";
import { credentialAad, type CredentialCipher } from "@intx/types";
import { type } from "arktype";
import { eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";

/**
 * Browser-driven OAuth sign-in for MCP servers, workbench-owned. The stock
 * OAuth login route serves the workbench's own static providers (Codex, xAI);
 * MCP servers are per-URL dynamic clients, so this route discovers the
 * authorization server from the resource URL (RFC 9728/8414), registers a
 * loopback client (RFC 7591), and stores the tokens on the server's `api_key`
 * credential row — the row shape the existing @corbits/mcp sidecar binding
 * already resolves, so that package needs no changes.
 */

/** Credential-metadata key carrying the dynamically registered client id, so a
 * future refresh pass can redeem the refresh token without re-registering. */
export const MCP_OAUTH_CLIENT_ID_METADATA_KEY = "mcpOAuthClientId";

/** Credential-metadata key carrying the token endpoint the tokens were
 * minted at, for the same future refresh pass. */
export const MCP_OAUTH_TOKEN_URL_METADATA_KEY = "mcpOAuthTokenUrl";

/** An abandoned login holds a loopback port, so it is not held long. */
const DEFAULT_LOGIN_TTL_MS = 5 * 60 * 1000;

/** An IPv4 host whose first octets put it off the public internet:
 * loopback, private, link-local, shared, documentation and the reserved
 * ranges a caller must never point discovery at. */
function isNonPublicIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return false;
    const octet = Number(part);
    if (!Number.isSafeInteger(octet) || octet > 255) return false;
    octets.push(octet);
  }
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

/** The last 32 bits of an IPv6 literal as dotted IPv4, or `undefined` when
 * the tail isn't two parseable hextets. */
function ipv6Last32AsIPv4(inner: string): string | undefined {
  const groups = inner.split(":").filter((group) => group !== "");
  if (groups.length < 2) return undefined;
  const hi = Number.parseInt(groups[groups.length - 2] ?? "", 16);
  const lo = Number.parseInt(groups[groups.length - 1] ?? "", 16);
  if (!Number.isSafeInteger(hi) || !Number.isSafeInteger(lo)) return undefined;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** A bracketed IPv6 host off the public internet: unspecified, loopback,
 * link-local, unique-local and multicast. High-zero space is mapped and
 * compatible territory (`::ffff:a.b.c.d`, `::a.b.c.d` — the serializer hexes
 * dotted tails), so its last 32 bits are judged as IPv4. */
function isNonPublicIPv6(host: string): boolean {
  const bracketed = host.startsWith("[") && host.endsWith("]");
  let inner = bracketed ? host.slice(1, -1) : host;
  const zone = inner.indexOf("%");
  if (zone !== -1) inner = inner.slice(0, zone);
  inner = inner.toLowerCase();
  const tail = inner.slice(inner.lastIndexOf(":") + 1);
  if (tail.includes(".")) return isNonPublicIPv4(tail);
  if (inner.startsWith("::")) {
    const rest = inner.slice(2);
    if (rest === "" || rest === "1") return true;
    const asIPv4 = ipv6Last32AsIPv4(inner);
    if (asIPv4 === undefined) return true;
    return isNonPublicIPv4(asIPv4);
  }
  const parts = inner.split(":");
  if (
    parts.length === 8 &&
    parts.slice(0, 7).every((group) => /^0+$/.test(group)) &&
    (parts[7] === "0" || parts[7] === "1")
  ) {
    return true;
  }
  const head = Number.parseInt((parts[0] ?? "").padEnd(4, "0").slice(0, 4), 16);
  if (Number.isNaN(head)) return false;
  if (head >= 0xfe80 && head <= 0xfebf) return true;
  if (head >= 0xfc00 && head <= 0xfdff) return true;
  if (head >= 0xff00) return true;
  return false;
}

function isNonPublicIpHost(host: string): boolean {
  // A colon marks an IPv6 literal (hostnames never carry one); its check
  // also judges an embedded IPv4 tail, so it must run before the IPv4 test.
  if (host.includes(":")) return isNonPublicIPv6(host);
  if (host.includes(".")) return isNonPublicIPv4(host);
  return false;
}

/** Why a caller-supplied discovery root is refused, or `undefined` when it
 * may be fetched. Discovery runs with the hub's network position, so the
 * root must be a public https URL — never plain http, this machine, or a
 * private or link-local address. */
export function resourceUrlRejection(resourceUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(resourceUrl);
  } catch {
    return "the server URL is not a valid URL";
  }
  if (parsed.protocol !== "https:") {
    return "the server URL must be an https URL";
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    return "the server URL must not target this machine";
  }
  if (isNonPublicIpHost(host)) {
    return "the server URL must not target a private or link-local address";
  }
  return undefined;
}

const StartMcpOAuthLogin = type({
  /** The stock `provider` catalog row the credential is filed under. */
  providerId: "string",
  /** The MCP server handle, e.g. "linear". */
  handle: "string",
  /** Display name recorded on the credential's mcp metadata. */
  name: "string",
  /** The MCP server URL the tokens are bound to. */
  url: "string",
  /** Resource URL discovery starts from; usually the server URL itself. */
  resourceUrl: "string",
  /** Credential name the tokens are stored under; re-sign-in replaces in place. */
  credentialName: "string",
  "scopes?": "string[]",
});

const DONE_HTML =
  "<!doctype html><meta charset=utf-8><title>Signed in</title><p>Signed in — you can close this tab and return to your workbench.";

const failedHtml = (reason: string): string =>
  `<!doctype html><meta charset=utf-8><title>Sign-in failed</title><p>Sign-in failed: ${reason.replace(/[<&]/g, "")}`;

export type MountMcpOAuthLoginOpts = {
  readonly db: DB["db"];
  readonly cipher: CredentialCipher;
  /** The host's stock grant middleware, so authority is checked exactly once, its way. */
  readonly requireGrant: MiddlewareHandler<TenantEnv>;
  readonly loginTtlMs?: number;
  readonly fetchImpl?: FetchLike;
  /** Bind the loopback callback and report the redirect URI to register. The
   * default binds an ephemeral port; tests stub it. */
  readonly startCallback?: (state: string) => Promise<{
    server: CallbackServer;
    redirectUri: string;
  }>;
  /** Reported when a login fails after the request that started it returned. */
  readonly onError?: (error: unknown, context: { handle: string }) => void;
};

type StoredMcpTokens = {
  access: string;
  refresh?: string;
  expiresAtMs?: number;
};

async function defaultStartCallback(
  state: string,
): Promise<{ server: CallbackServer; redirectUri: string }> {
  const server = await startCallbackServer(state, {
    port: 0,
    host: "127.0.0.1",
    path: "/callback",
    doneHtml: DONE_HTML,
    failedHtml,
  });
  if (server.port === undefined) {
    server.close();
    throw new OAuthDiscoveryError("the callback server did not expose a bound port.");
  }
  return { server, redirectUri: `http://127.0.0.1:${String(server.port)}/callback` };
}

/**
 * Mount browser-driven MCP OAuth login on a tenant router. The browser gets
 * an authorize URL and a login id and nothing else: discovery, registration,
 * the PKCE verifier, the loopback listener and the token exchange all stay in
 * this process, and the only thing that crosses back out is the id of the
 * credential the tokens were stored under.
 */
export function mountMcpOAuthLogin(app: Hono<TenantEnv>, opts: MountMcpOAuthLoginOpts): void {
  const logins = createLoginStore();
  const ttlMs = opts.loginTtlMs ?? DEFAULT_LOGIN_TTL_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const startCallback = opts.startCallback ?? defaultStartCallback;

  const owner = (c: {
    get(key: "tenant" | "principal"): { id: string };
  }): { tenantId: string; principalId: string } => ({
    tenantId: c.get("tenant").id,
    principalId: c.get("principal").id,
  });

  async function storeTokens(args: {
    tenantId: string;
    principalId: string;
    providerId: string;
    credentialName: string;
    handle: string;
    name: string;
    url: string;
    scopes: readonly string[];
    clientId: string;
    tokenUrl: string;
    tokens: StoredMcpTokens;
  }): Promise<string> {
    const existing = await opts.db.query.credential.findFirst({
      where: (row, { and, eq }) =>
        and(eq(row.tenantId, args.tenantId), eq(row.name, args.credentialName)),
    });

    const now = new Date();
    const credentialId = existing?.id ?? generateId("credential");
    const metadata = {
      mcp: {
        handle: args.handle,
        name: args.name,
        url: args.url,
        auth: "oauth",
        tools: [],
      },
      [MCP_OAUTH_CLIENT_ID_METADATA_KEY]: args.clientId,
      [MCP_OAUTH_TOKEN_URL_METADATA_KEY]: args.tokenUrl,
    };
    const secret = await opts.cipher.encrypt(
      args.tokens.access,
      credentialAad(credentialId, "secret"),
    );
    const refreshSecret =
      args.tokens.refresh === undefined
        ? null
        : await opts.cipher.encrypt(
            args.tokens.refresh,
            credentialAad(credentialId, "refreshSecret"),
          );
    // The row stays `api_key` so the existing MCP sidecar binding resolves
    // it unchanged; the OAuth material rides alongside for a refresh pass.
    const row = {
      providerId: args.providerId,
      scopes: [...args.scopes],
      type: "api_key" as const,
      secret,
      refreshSecret,
      expiresAt: args.tokens.expiresAtMs === undefined ? null : new Date(args.tokens.expiresAtMs),
      status: "active" as const,
      metadata,
      updatedAt: now,
    };

    if (existing !== undefined) {
      await opts.db.update(credential).set(row).where(eq(credential.id, credentialId));
      return credentialId;
    }

    await opts.db.transaction(async (tx) => {
      await tx.insert(credential).values({
        id: credentialId,
        tenantId: args.tenantId,
        principalId: args.principalId,
        name: args.credentialName,
        description: null,
        createdAt: now,
        ...row,
      });
      // Mirrors the stock route: a personal credential grants its owner
      // durable `use` authority so no separate manual grant is needed.
      await tx.insert(grantTable).values({
        id: generateId("grant"),
        tenantId: args.tenantId,
        principalId: args.principalId,
        resource: `credential:${credentialId}`,
        action: "use",
        effect: "allow",
        origin: "creator",
        expiresAt: null,
        createdAt: now,
        updatedAt: now,
      });
    });
    return credentialId;
  }

  app.post("/mcp/oauth-logins", opts.requireGrant, async (c) => {
    const body = StartMcpOAuthLogin(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json({ error: body.summary }, 400);
    }

    const { tenantId, principalId } = owner(c);
    const scopes = body.scopes ?? [];

    const rejected = resourceUrlRejection(body.resourceUrl);
    if (rejected !== undefined) {
      opts.onError?.(new Error(rejected), { handle: body.handle });
      return c.json({ error: rejected }, 400);
    }

    let entry: McpLoginEntry;
    try {
      entry = await discoverMcpLoginEntry({
        resourceUrl: body.resourceUrl,
        fetchImpl,
      });
    } catch (cause) {
      opts.onError?.(cause, { handle: body.handle });
      return c.json({ error: cause instanceof Error ? cause.message : String(cause) }, 400);
    }
    if (entry.authorizationServer.registrationEndpoint === undefined) {
      return c.json({ error: "this MCP server does not support dynamic client registration" }, 400);
    }

    const pkce = generatePkce();
    const state = generateState();
    const abort = new AbortController();

    let callback: { server: CallbackServer; redirectUri: string };
    try {
      callback = await startCallback(state);
    } catch (cause) {
      opts.onError?.(cause, { handle: body.handle });
      return c.json({ error: cause instanceof Error ? cause.message : String(cause) }, 409);
    }

    let clientId: string;
    try {
      ({ clientId } = await registerMcpClient({
        registrationEndpoint: entry.authorizationServer.registrationEndpoint,
        redirectUris: [callback.redirectUri],
        clientName: "Corbits Workbench",
        fetchImpl,
      }));
    } catch (cause) {
      callback.server.close();
      opts.onError?.(cause, { handle: body.handle });
      return c.json({ error: cause instanceof Error ? cause.message : String(cause) }, 400);
    }

    const config = mcpClientConfig(entry, {
      clientId,
      redirectUri: callback.redirectUri,
      scopes,
    });
    const authorizeUrl = buildAuthorizeUrl(config, pkce, state);

    const loginId = logins.create({
      tenantId,
      principalId,
      expiresAt: Date.now() + ttlMs,
      abort,
      cancel: () => callback.server.close(),
    });

    // Detached on purpose: the redirect lands minutes after this response.
    void callback.server
      .waitForCode(abort.signal)
      .then(async (code) => {
        try {
          const exchanged = Date.now();
          const response = await exchangeCode(config, code, pkce.verifier, fetchImpl);
          const credentialId = await storeTokens({
            tenantId,
            principalId,
            providerId: body.providerId,
            credentialName: body.credentialName,
            handle: body.handle,
            name: body.name,
            url: body.url,
            scopes,
            clientId,
            tokenUrl: entry.authorizationServer.tokenEndpoint,
            tokens: {
              access: response.access_token,
              ...(response.refresh_token !== undefined ? { refresh: response.refresh_token } : {}),
              ...(response.expires_in !== undefined
                ? { expiresAtMs: exchanged + response.expires_in * 1000 }
                : {}),
            },
          });
          logins.settle(loginId, { status: "completed", credentialId });
        } catch (cause) {
          opts.onError?.(cause, { handle: body.handle });
          logins.settle(loginId, {
            status: "failed",
            message: "the tokens could not be stored",
          });
        } finally {
          callback.server.close();
        }
      })
      .catch((cause: unknown) => {
        opts.onError?.(cause, { handle: body.handle });
        logins.settle(loginId, {
          status: "failed",
          message: cause instanceof Error ? cause.message : String(cause),
        });
        callback.server.close();
      });

    return c.json({ loginId, authorizeUrl }, 201);
  });

  app.get("/mcp/oauth-logins/:loginId", opts.requireGrant, (c) => {
    const state: LoginState | undefined = logins.read(c.req.param("loginId"), owner(c));
    if (state === undefined) return c.json({ error: "not_found" }, 404);
    return c.json(state);
  });

  app.delete("/mcp/oauth-logins/:loginId", opts.requireGrant, (c) =>
    logins.cancel(c.req.param("loginId"), owner(c))
      ? c.body(null, 204)
      : c.json({ error: "not_found" }, 404),
  );
}
