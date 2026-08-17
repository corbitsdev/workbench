// Curated MCP preset cards (CL-6152): Granola/Exa/Linear each get a
// one-click card here instead of the generic "Add MCP server" form —
// connecting still goes through the exact same connect route as a
// hand-typed server (`mcp-servers-api.ts`'s `connectMcpPreset`), just with
// the preset's slug instead of a pasted name/url. Self-contained fetch/
// connect/disconnect loop, same shape as `mcp-servers-section.tsx`'s
// `McpServersSection`.

import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardTitle,
  ConfirmButton,
  Input,
  toast,
} from "@corbits/react-ui";
import { Plug } from "lucide-react";
import { useEffect, useState } from "react";

import {
  McpServersApiError,
  connectMcpPreset,
  disconnectMcpServer,
  listMcpPresets,
  mcpOAuthStartPath,
  type McpPreset,
} from "./mcp-servers-api";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function McpPresetCard({
  tenantId,
  preset,
  toolCount,
  onChanged,
}: {
  readonly tenantId: string;
  readonly preset: McpPreset;
  readonly toolCount: number | undefined;
  readonly onChanged: (toolCount?: number) => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleConnect() {
    setBusy(true);
    setError(null);
    connectMcpPreset(
      tenantId,
      preset.slug,
      token.trim() === "" ? undefined : token.trim(),
    )
      .then((result) => {
        toast(
          `Connected — ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"} available.`,
        );
        onChanged(result.toolCount);
      })
      .catch((cause: unknown) => {
        if (
          cause instanceof McpServersApiError &&
          cause.code === "oauth_required"
        ) {
          window.location.href = mcpOAuthStartPath(tenantId, preset.slug);
          return;
        }
        setError(messageOf(cause));
      })
      .finally(() => setBusy(false));
  }

  function handleDisconnect() {
    setBusy(true);
    setError(null);
    disconnectMcpServer(tenantId, preset.slug)
      .then(() => {
        toast(`${preset.displayName} disconnected.`);
        onChanged();
      })
      .catch(() => setError("Couldn't disconnect — try again."))
      .finally(() => setBusy(false));
  }

  return (
    <Card className="gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center border border-border text-muted-foreground"
        >
          <Plug className="size-4" />
        </span>
        {preset.connected ? (
          <ConfirmButton
            variant="destructive"
            size="sm"
            confirmLabel="Disconnect"
            disabled={busy}
            onConfirm={handleDisconnect}
          >
            {busy ? "Disconnecting…" : "Disconnect"}
          </ConfirmButton>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={handleConnect}
          >
            {busy ? "Connecting…" : "Connect"}
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <CardTitle>{preset.displayName}</CardTitle>
        <CardDescription>{preset.description}</CardDescription>
      </div>
      {!preset.connected && preset.keyOptional ? (
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          API key (optional)
          <Input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              setError(null);
            }}
          />
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={preset.connected ? "success" : "neutral"}>
          {preset.connected ? "Connected" : "Not connected"}
        </Badge>
        <span className="text-xs text-muted-foreground">via MCP</span>
        {preset.connected && toolCount !== undefined ? (
          <span className="text-xs text-muted-foreground">
            {toolCount} tool{toolCount === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      {error !== null ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </Card>
  );
}

export function McpPresetCardsSection({ tenantId }: { readonly tenantId: string }) {
  const [presets, setPresets] = useState<readonly McpPreset[]>([]);
  const [toolCounts, setToolCounts] = useState<ReadonlyMap<string, number>>(
    new Map(),
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  function reload() {
    listMcpPresets(tenantId)
      .then((data) => {
        setPresets(data);
        setLoadError(null);
      })
      .catch((cause: unknown) => setLoadError(messageOf(cause)));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  if (presets.length === 0 && loadError === null) return null;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Featured MCP servers
      </h3>
      {loadError !== null ? (
        <p className="text-sm text-destructive" role="alert">
          {loadError}
        </p>
      ) : null}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
        {presets.map((preset) => (
          <McpPresetCard
            key={preset.slug}
            tenantId={tenantId}
            preset={preset}
            toolCount={toolCounts.get(preset.slug)}
            onChanged={(toolCount) => {
              if (toolCount !== undefined) {
                setToolCounts((prev) => new Map(prev).set(preset.slug, toolCount));
              }
              reload();
            }}
          />
        ))}
      </div>
    </section>
  );
}
