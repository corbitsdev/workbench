// The MCP-server connector's tenant-scoped CRUD surface (CL-6142): drop a
// name + Streamable HTTP URL (+ optional bearer token) in Plugins and it
// becomes a `mcp:<slug>` credential handle every agent can reach through
// `@corbits/mcp-tools`' `mcp_list_servers`/`mcp_list_tools`/`mcp_call`.
//
// Unlike `./routes.ts`'s fixed `CONNECTOR_REGISTRY` entries (one row per
// known provider, keyed by a static id), an MCP server is tenant-minted:
// many per tenant, each under a slug derived from the name the person
// typed. Storage still goes through the exact same `ensureProvider`/
// `ensureCredential` seam `routes.ts`' `/complete` uses — never a second
// credential-storage mechanism — but the provider row also carries an
// explicit `apiBaseUrl` (the server's own origin), since this connector's
// origin is tenant data, not a fixed constant the hub-side plugin already
// knows the way it does for GitHub or Exa.
import { Hono, type Context } from "hono";
import { type } from "arktype";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import {
  CredentialResponse,
  ProviderResponse,
  paginatedSchema,
} from "@intx/types";
import {
  cookiesFromHeader,
  createHubAPI,
  ensureCredential,
  ensureProvider,
  parseAs,
  type ApiCall,
} from "@workbench/hub-client";
import { probeMcpServer } from "./mcp-probe";

const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

/** Every stored MCP server provider is named `mcp:<slug>` — the same
 * convention `@corbits/mcp-tools`' `mcpCredentialHandle` builds from the
 * `server` argument `mcp_list_tools`/`mcp_call` take. */
const MCP_PROVIDER_PREFIX = "mcp:";

function providerName(slug: string): string {
  return `${MCP_PROVIDER_PREFIX}${slug}`;
}

function slugOf(name: string): string {
  return name.slice(MCP_PROVIDER_PREFIX.length);
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "server";
}

/** A pasted token with no real secret still has to satisfy credential
 * storage's non-empty `secret` — a tokenless MCP server is stored under
 * this sentinel rather than skipping credential storage entirely, since
 * `@corbits/mcp-tools`' `mcp_call` resolves its mediated fetch through a
 * bound credential handle with no "no credential needed" path. [Intx
 * gap]: there is no credential-free, origin-pinned mediated fetch in
 * this substrate — a public MCP server with no auth still sends an
 * (unused) bearer header few servers will reject, but a stricter one
 * could. */
const NO_TOKEN_SENTINEL = "unauthenticated-mcp-server";

const SubmitMcpServer = type({
  name: "string > 0",
  url: "string > 0",
  "token?": "string | undefined",
});

type ProviderRow = typeof ProviderResponse.infer;
type CredentialRow = typeof CredentialResponse.infer;

export type McpServerSummary = {
  readonly slug: string;
  readonly name: string;
  readonly url: string;
};

export type McpServerConnected = McpServerSummary & {
  readonly toolCount: number;
};

export type CreateMcpServerRoutesDeps = {
  hubUrl: string;
  requireGrant: RequireGrant;
  log: (line: string) => void;
  /** Test-only override, matching `routes.ts`' own `ensureProviderFn`
   * pattern — lets `mcp-server-routes.test.ts` stub credential storage
   * without a network. */
  apiCall?: ApiCall;
  probe?: typeof probeMcpServer;
};

async function listMcpProviders(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<readonly ProviderRow[]> {
  const listed = await api(
    "GET",
    `/api/tenants/${tenantId}/providers?inherited=false`,
    undefined,
    cookies,
  );
  const providers = parseAs(
    paginatedSchema(ProviderResponse),
    listed.data,
    "providers response",
  ).data;
  return providers.filter((p) => p.name.startsWith(MCP_PROVIDER_PREFIX));
}

async function listMcpCredentials(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<readonly CredentialRow[]> {
  const listed = await api(
    "GET",
    `/api/tenants/${tenantId}/credentials`,
    undefined,
    cookies,
  );
  return parseAs(
    paginatedSchema(CredentialResponse),
    listed.data,
    "credentials response",
  ).data;
}

function uniqueSlug(desired: string, taken: ReadonlySet<string>): string {
  if (!taken.has(desired)) return desired;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${desired}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`could not derive a unique slug from "${desired}"`);
}

export function createMcpServerRoutes(
  deps: CreateMcpServerRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  const api = deps.apiCall ?? createHubAPI(deps.hubUrl);
  const probe = deps.probe ?? probeMcpServer;

  app.get("/", deps.requireGrant("credential:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const cookies = cookiesFromHeader(c.req.header("cookie"));
    const [providers, credentials] = await Promise.all([
      listMcpProviders(api, cookies, tenant.id),
      listMcpCredentials(api, cookies, tenant.id),
    ]);
    const credentialByProviderId = new Map(
      credentials.map((cred) => [cred.providerId, cred]),
    );
    const servers: McpServerSummary[] = providers.map((provider) => ({
      slug: slugOf(provider.name),
      name: credentialByProviderId.get(provider.id)?.name ?? provider.name,
      url: provider.apiBaseUrl ?? "",
    }));
    return c.json({ data: servers }, 200);
  });

  app.post("/", deps.requireGrant("credential:*", "create"), async (c) => {
    const body: unknown = await (c as Context<TenantEnv>).req
      .json()
      .catch(() => null);
    const parsed = SubmitMcpServer(body);
    if (parsed instanceof type.errors) {
      return c.json(
        ErrorEnvelope("bad_request", `Invalid MCP server: ${parsed.summary}`),
        400,
      );
    }

    const test = await probe(parsed.url, parsed.token);
    if (!test.ok) {
      return c.json(ErrorEnvelope("connect_failed", test.message), 422);
    }

    const tenant = c.get("tenant");
    const cookies = cookiesFromHeader(c.req.header("cookie"));
    const existingProviders = await listMcpProviders(api, cookies, tenant.id);
    const takenSlugs = new Set(existingProviders.map((p) => slugOf(p.name)));
    const slug = uniqueSlug(slugify(parsed.name), takenSlugs);
    const origin = new URL(parsed.url).origin;

    try {
      const providerId = await ensureProvider(
        api,
        cookies,
        {
          tenantId: tenant.id,
          name: providerName(slug),
          plugin: "http",
          apiBaseUrl: origin,
        },
        deps.log,
      );
      await ensureCredential(
        api,
        cookies,
        {
          tenantId: tenant.id,
          providerId,
          name: parsed.name,
          secret:
            parsed.token && parsed.token.length > 0
              ? parsed.token
              : NO_TOKEN_SENTINEL,
          type: "api_key",
          metadata: { url: parsed.url, name: parsed.name },
          verified: true,
        },
        deps.log,
      );
      const connected: McpServerConnected = {
        slug,
        name: parsed.name,
        url: parsed.url,
        toolCount: test.toolCount,
      };
      return c.json(connected, 200);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      deps.log(
        `mcp server connect failed for tenant ${tenant.id}, slug ${slug}: ${message}`,
      );
      return c.json(
        ErrorEnvelope(
          "connection_setup_failed",
          "That MCP server checked out, but saving the connection failed. Try again in a moment.",
        ),
        500,
      );
    }
  });

  app.delete(
    "/:slug",
    deps.requireGrant("credential:*", "create"),
    async (c) => {
      const slug = c.req.param("slug");
      const tenant = c.get("tenant");
      const cookies = cookiesFromHeader(c.req.header("cookie"));
      const providers = await listMcpProviders(api, cookies, tenant.id);
      const provider = providers.find((p) => p.name === providerName(slug));
      if (provider === undefined) {
        return c.json(
          ErrorEnvelope("not_found", `No MCP server connected at "${slug}"`),
          404,
        );
      }
      const credentials = await listMcpCredentials(api, cookies, tenant.id);
      const credential = credentials.find(
        (cred) => cred.providerId === provider.id,
      );
      if (credential !== undefined) {
        await api(
          "DELETE",
          `/api/tenants/${tenant.id}/credentials/${credential.id}`,
          undefined,
          cookies,
        );
      }
      return c.body(null, 204);
    },
  );

  return app;
}
