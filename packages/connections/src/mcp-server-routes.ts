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
  makeErrorEnvelope,
  parseAs,
  type ApiCall,
} from "@workbench/hub-client";
import {
  MCP_NO_TOKEN_SENTINEL,
  MCP_STREAMABLE_HTTP_PROVIDER_KEY,
} from "@corbits/credential-providers";
import { probeMcpServer } from "./mcp-probe";
import { fireConnectedHook, type ServiceConnectedHook } from "./connected-hook";
import { reportError } from "@corbits/error-sink";
import { MCP_PRESETS, mcpPresetBySlug } from "./mcp-presets";

/** Every stored MCP server provider is named `mcp:<slug>` — the same
 * convention `@corbits/mcp-tools`' `mcpCredentialHandle` builds from the
 * `server` argument `mcp_list_tools`/`mcp_call` take. */
const MCP_PROVIDER_PREFIX = "mcp:";

export function providerName(slug: string): string {
  return `${MCP_PROVIDER_PREFIX}${slug}`;
}

export function slugOf(name: string): string {
  return name.slice(MCP_PROVIDER_PREFIX.length);
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "server";
}

/** A pasted token with no real secret still has to satisfy credential
 * storage's non-empty `secret` — a tokenless MCP server is stored under
 * `MCP_NO_TOKEN_SENTINEL`, and the `mcp-streamable-http` provider plugin
 * (which owns the constant) reads it back as "send no authorization
 * header", so a keyless public server like Exa never sees a bogus
 * bearer it would 401. */
export const NO_TOKEN_SENTINEL = MCP_NO_TOKEN_SENTINEL;

/** Either a hand-typed `name`+`url` (the original CL-6142 shape) or a
 * curated `presetSlug` (CL-6152) -- resolving a preset's fixed `url`/
 * `displayName` happens in the route handler below, never trusted off
 * the wire, so a preset connect can never be redirected at an arbitrary
 * URL by tampering with the request body. */
const SubmitMcpServer = type({
  "name?": "string > 0",
  "url?": "string > 0",
  "presetSlug?": "string > 0",
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
  /** Fires once for every durably stored connection, whatever the
   * connector — the composition's connect-settling seam (flip in-room
   * connect cards, resume waiting agents). Failures are logged and
   * never surface into the response. */
  onConnected?: ServiceConnectedHook;
};

export async function listMcpProviders(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  opts?: { inherited?: boolean },
): Promise<readonly ProviderRow[]> {
  const inherited = opts?.inherited ?? false;
  const listed = await api(
    "GET",
    `/api/tenants/${tenantId}/providers?inherited=${inherited}`,
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

export async function listMcpCredentials(
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

export function uniqueSlug(
  desired: string,
  taken: ReadonlySet<string>,
): string {
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

  app.get("/presets", deps.requireGrant("credential:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const cookies = cookiesFromHeader(c.req.header("cookie"));
    const [providers, credentials] = await Promise.all([
      listMcpProviders(api, cookies, tenant.id),
      listMcpCredentials(api, cookies, tenant.id),
    ]);
    const credentialByProviderId = new Map(
      credentials.map((cred) => [cred.providerId, cred]),
    );
    const providerBySlug = new Map(
      providers.map((provider) => [slugOf(provider.name), provider]),
    );
    const presets = MCP_PRESETS.map((preset) => {
      const provider = providerBySlug.get(preset.slug);
      const credential =
        provider === undefined
          ? undefined
          : credentialByProviderId.get(provider.id);
      return {
        slug: preset.slug,
        displayName: preset.displayName,
        description: preset.description,
        url: preset.url,
        connectionMode: preset.connectionMode,
        docsUrl: preset.docsUrl,
        ...(preset.icon === undefined ? {} : { icon: preset.icon }),
        ...(preset.tokenSteps === undefined
          ? {}
          : { tokenSteps: preset.tokenSteps }),
        connected: credential !== undefined,
      };
    });
    return c.json({ data: presets }, 200);
  });

  app.post("/", deps.requireGrant("credential:*", "create"), async (c) => {
    const body: unknown = await (c as Context<TenantEnv>).req
      .json()
      .catch(() => null);
    const parsed = SubmitMcpServer(body);
    if (parsed instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `Invalid MCP server: ${parsed.summary}`,
        }),
        400,
      );
    }

    const preset =
      parsed.presetSlug !== undefined
        ? mcpPresetBySlug(parsed.presetSlug)
        : undefined;
    if (parsed.presetSlug !== undefined && preset === undefined) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `Unknown MCP server preset: "${parsed.presetSlug}"`,
        }),
        400,
      );
    }
    if (
      preset?.connectionMode === "token" &&
      (parsed.token === undefined || parsed.token.length === 0)
    ) {
      return c.json(
        makeErrorEnvelope({
          code: "token_required",
          userMessage: `${preset.displayName} needs an access token — create one at ${preset.docsUrl} and paste it in.`,
        }),
        400,
      );
    }
    const name = preset?.displayName ?? parsed.name;
    const url = preset?.url ?? parsed.url;
    if (name === undefined || url === undefined) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage:
            "Invalid MCP server: provide either presetSlug, or both name and url.",
        }),
        400,
      );
    }

    const test = await probe(url, parsed.token);
    if (!test.ok) {
      return c.json(
        test.requiresOAuth === true
          ? makeErrorEnvelope({
              code: "oauth_required",
              userMessage: test.message,
            })
          : makeErrorEnvelope({
              code: "connect_failed",
              userMessage: test.message,
            }),
        422,
      );
    }

    const tenant = c.get("tenant");
    const cookies = cookiesFromHeader(c.req.header("cookie"));
    const existingProviders = await listMcpProviders(api, cookies, tenant.id);
    const takenSlugs = new Set(existingProviders.map((p) => slugOf(p.name)));
    const slug =
      preset !== undefined && !takenSlugs.has(preset.slug)
        ? preset.slug
        : uniqueSlug(slugify(name), takenSlugs);
    // Store the FULL endpoint URL, path included — MCP servers live at a
    // path (e.g. https://mcp.granola.ai/mcp); storing only the origin sent
    // every later mcp_list_tools/mcp_call to the root, where nothing
    // answers (bit a live connect).
    const endpointUrl = new URL(url).toString();

    try {
      const providerId = await ensureProvider(
        api,
        cookies,
        {
          tenantId: tenant.id,
          name: providerName(slug),
          plugin: MCP_STREAMABLE_HTTP_PROVIDER_KEY,
          apiBaseUrl: endpointUrl,
        },
        deps.log,
      );
      await ensureCredential(
        api,
        cookies,
        {
          tenantId: tenant.id,
          providerId,
          name,
          secret:
            parsed.token && parsed.token.length > 0
              ? parsed.token
              : NO_TOKEN_SENTINEL,
          type: "api_key",
          metadata: { url, name },
          verified: true,
        },
        deps.log,
      );
      await fireConnectedHook(deps.onConnected, deps.log, {
        tenantId: tenant.id,
        principalId: c.get("principal").id,
        connectorId: slug,
        displayName: name,
      });
      const connected: McpServerConnected = {
        slug,
        name,
        url,
        toolCount: test.toolCount,
      };
      return c.json(connected, 200);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      deps.log(
        `mcp server connect failed for tenant ${tenant.id}, slug ${slug}: ${message}`,
      );
      // Never widen extra beyond identifiers safe to print — `cause` here
      // can carry the pasted bearer token in scope above.
      const refId = reportError(cause, {
        operation: "persist_mcp_server_connection",
        tenantId: tenant.id,
        extra: { slug },
      });
      return c.json(
        makeErrorEnvelope({
          code: "connection_setup_failed",
          userMessage:
            "That MCP server checked out, but saving the connection failed. Try again in a moment.",
          refId,
        }),
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
        // The tenant's own list (own-tenant only, matching `GET /`) has
        // no such slug — but CL-6191's inheritance means an ancestor's
        // connection can still resolve for this tenant's tools, so a
        // second, inherited-inclusive lookup distinguishes "no such
        // server anywhere in the chain" from "it exists, but only at an
        // ancestor" — the latter is refused with a specific, actionable
        // error rather than a generic not-found, mirroring
        // `@corbits/skills`' `requireOwnTenant`. Either way nothing is
        // mutated: disconnecting an inherited connection is a hard cut,
        // never a shadow-delete row.
        const inheritedProviders = await listMcpProviders(
          api,
          cookies,
          tenant.id,
          { inherited: true },
        );
        const inheritedProvider = inheritedProviders.find(
          (p) => p.name === providerName(slug),
        );
        if (inheritedProvider !== undefined) {
          return c.json(
            makeErrorEnvelope({
              code: "forbidden",
              userMessage: `"${slug}" is inherited from a parent workbench — disconnect it from the workbench that owns it, not from a child.`,
            }),
            403,
          );
        }
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: `No MCP server connected at "${slug}"`,
          }),
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
      // The provider row is the connection as far as the listing is
      // concerned — deleting only the credential left a ghost entry
      // that re-listed forever.
      await api(
        "DELETE",
        `/api/tenants/${tenant.id}/providers/${provider.id}`,
        undefined,
        cookies,
      );
      return c.body(null, 204);
    },
  );

  return app;
}
