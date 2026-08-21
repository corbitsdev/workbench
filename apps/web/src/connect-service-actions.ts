// Builds the `ConnectServiceActions` port `ChatWorkspace` (`@corbits/chat-ui`)
// calls for the generic in-room connect card (CL-6393) — the
// `connect-github-actions.ts` shape generalized to every connector and
// MCP preset. The block's data carries only agent-authored framing;
// every live fact is resolved here: a curated preset reads the
// tenant's MCP preset listing (connected flag + oauth/keyless mode), a
// registry connector reads `oauth-configured` (one-click vs key-paste)
// and the tenant's provider rows (connected or not).
//
// OAuth connects navigate the whole page to the hosted start route and
// return to this room; the card re-reads its state on remount, and the
// hub's connect-settling hook posts the in-room resume message — so no
// client-side event fold is needed for the flip.
import type {
  ConnectAffordance,
  ConnectServiceActions,
  ConnectServiceQuery,
} from "@corbits/chat-ui";
import {
  completeConnectorCredential,
  ConnectionsApiError,
  fetchOAuthConfigured,
  listProviders,
  oauthStartHref,
} from "@corbits/settings-ui";
import {
  connectMcpPreset,
  listMcpPresets,
  McpServersApiError,
} from "@corbits/plugins-ui";
import { CONNECTOR_REGISTRY } from "@workbench/connections/registry";
import { mcpPresetBySlug } from "@workbench/connections/mcp-presets";

function bareConnectorId(connectorId: string): string {
  return connectorId.startsWith("mcp:")
    ? connectorId.slice("mcp:".length)
    : connectorId;
}

export function createChatConnectServiceActions(
  tenantId: string,
  returnPath: string,
): ConnectServiceActions {
  const listeners = new Map<string, Set<(q: ConnectServiceQuery) => void>>();

  function fanOut(connectorId: string, query: ConnectServiceQuery) {
    for (const listener of listeners.get(connectorId) ?? []) listener(query);
  }

  async function readState(connectorId: string): Promise<ConnectServiceQuery> {
    const slug = bareConnectorId(connectorId);
    const preset = mcpPresetBySlug(slug);
    if (preset !== undefined) {
      const presets = await listMcpPresets(tenantId);
      const listed = presets.find((entry) => entry.slug === preset.slug);
      if (listed?.connected === true) return { kind: "connected" };
      if (preset.connectionMode === "keyless") {
        return { kind: "disconnected", affordance: "keyless" };
      }
      if (preset.connectionMode === "token") {
        return {
          kind: "disconnected",
          affordance: "api-key",
          docsUrl: preset.docsUrl,
        };
      }
      return { kind: "disconnected", affordance: "oauth" };
    }

    const descriptor = CONNECTOR_REGISTRY[slug];
    if (descriptor === undefined) {
      return { kind: "error", message: "This service isn't available here." };
    }
    const [providers, oauthConfigured] = await Promise.all([
      listProviders(tenantId),
      descriptor.oauth !== undefined
        ? fetchOAuthConfigured(tenantId)
        : Promise.resolve<Readonly<Record<string, boolean>>>({}),
    ]);
    if (providers.some((provider) => provider.name === descriptor.id)) {
      return { kind: "connected" };
    }
    if (descriptor.oauth !== undefined && oauthConfigured[slug] === true) {
      return { kind: "disconnected", affordance: "oauth" };
    }
    if (descriptor.authKind === "api-key") {
      return {
        kind: "disconnected",
        affordance: "api-key",
        docsUrl: descriptor.docsUrl,
      };
    }
    // A pure-OAuth connector with no configured hosted app has no
    // affordance a person can use here — say so instead of rendering a
    // key field no key can satisfy.
    return {
      kind: "error",
      message: "This connect isn't set up on this server yet.",
    };
  }

  return {
    getConnectState(connectorId) {
      return readState(connectorId).catch(() => ({
        kind: "error" as const,
        message: "Couldn't check this connection. Try again.",
      }));
    },
    subscribeConnectState(connectorId, onUpdate) {
      const set = listeners.get(connectorId) ?? new Set();
      set.add(onUpdate);
      listeners.set(connectorId, set);
      return () => {
        set.delete(onUpdate);
      };
    },
    async connect(connectorId) {
      const slug = bareConnectorId(connectorId);
      const preset = mcpPresetBySlug(slug);
      if (preset !== undefined && preset.connectionMode === "keyless") {
        try {
          await connectMcpPreset(tenantId, preset.slug, undefined);
        } catch {
          return { ok: false, message: "Couldn't connect. Try again." };
        }
        fanOut(connectorId, { kind: "connected" });
        return { ok: true };
      }
      const startHref =
        preset !== undefined
          ? `/api/tenants/${tenantId}/mcp-servers/oauth/${preset.slug}/start?return=${encodeURIComponent(returnPath)}`
          : oauthStartHref(tenantId, slug, returnPath);
      window.location.href = startHref;
      return { ok: true };
    },
    async submitKey(connectorId, key) {
      const slug = bareConnectorId(connectorId);
      const preset = mcpPresetBySlug(slug);
      if (preset !== undefined && preset.connectionMode === "token") {
        try {
          await connectMcpPreset(tenantId, preset.slug, key);
        } catch (cause) {
          const message =
            cause instanceof McpServersApiError
              ? cause.message
              : "Couldn't connect with that token. Try again.";
          return { ok: false, message };
        }
        fanOut(connectorId, { kind: "connected" });
        return { ok: true };
      }
      try {
        await completeConnectorCredential(tenantId, slug, key);
      } catch (cause) {
        const message =
          cause instanceof ConnectionsApiError
            ? cause.message
            : "Couldn't connect with that key. Try again.";
        return { ok: false, message };
      }
      fanOut(connectorId, { kind: "connected" });
      return { ok: true };
    },
  };
}
