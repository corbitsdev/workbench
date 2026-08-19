// The "Memory" settings section: a read-only report of whether assistant
// memory can search by meaning or only by matching words, and how to
// change it — over `apps/hub/src/memory-status.ts`'s
// `GET /api/tenants/:tenantId/memory/status`. This section writes nothing;
// retention controls (forget/purge) are explicitly out of scope (CL-6289).
//
// Config is env-only (an operator's own deploy setting, never a connected
// credential — CL-6289's simpler design), so there is nothing here for a
// person to click to change it beyond setting env vars themselves.
//
// `source`/`embeddingsConfigured` are the two facts that matter most, so
// they lead. Everything else — the embed model, its host, re-rank config,
// raw per-flag degrade rates — is internal vocabulary that belongs in the
// "Details" disclosure for someone who wants it, never the headline.

import { Button, EmptyState, SettingsPanel } from "@corbits/react-ui";
import { ChevronRight, CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import type { APIQuery } from "@corbits/api-query";
import { SignedOutNotice, UnauthenticatedError } from "@corbits/api-query";

import {
  fetchMemoryStatus,
  type MemoryCallerScope,
  type MemoryPlaneStatus,
  type MemorySetupOption,
  type MemoryStatusResponse,
} from "./memory-api";
import {
  MEMORY_ALARM_DEGRADE_FLAGS,
  MEMORY_DEGRADE_FLAG_LABEL,
} from "./memory-degrade-vocabulary";
import { SETTINGS_STRINGS } from "./strings";

function formatSince(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** Alarm-worthy flags currently escalated, in `MEMORY_ALARM_DEGRADE_FLAGS`'
 * fixed order — never includes `lexical_only`, which that module's own
 * header explains is a chosen configuration, not a fault. */
function activeAlarms(
  degrade: MemoryPlaneStatus["degrade"],
): readonly string[] {
  return MEMORY_ALARM_DEGRADE_FLAGS.filter(
    (flag) => degrade.escalated[flag] === true,
  );
}

export function MemorySection({
  tenantId,
}: {
  readonly tenantId: string | null;
}) {
  const [query, setQuery] = useState<APIQuery<MemoryStatusResponse>>({
    kind: "loading",
  });
  const [reloadKey, setReloadKey] = useState(0);

  function reload() {
    setReloadKey((value) => value + 1);
  }

  useEffect(() => {
    if (tenantId === null) return;
    let cancelled = false;
    setQuery({ kind: "loading" });
    fetchMemoryStatus(tenantId)
      .then((data) => {
        if (!cancelled) setQuery({ kind: "ready", data });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof UnauthenticatedError) {
          setQuery({ kind: "unauthenticated" });
          return;
        }
        // `describeStatus` never throws for "lexical-only" — the floor
        // every config resolves to — and a caller who holds no memory here
        // is reported as an `unscoped` 200 rather than raised, so a thrown
        // error is always a genuine infrastructure fault (a missing
        // pgvector extension, an unreachable database), never a person's
        // own access. The contract gives no way to tell one infra fault
        // from another, so the copy stays honest about "an operator must
        // look at the server" rather than naming a cause it can't confirm.
        setQuery({
          kind: "error",
          message: SETTINGS_STRINGS.memoryErrorDescription,
          retry: reload,
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, reloadKey]);

  if (tenantId === null) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.benchNoneSelectedTitle}
        description={SETTINGS_STRINGS.benchNoneSelectedDescription}
      />
    );
  }

  switch (query.kind) {
    case "loading":
      // A warm line, not a bare spinner — this is a status report, and
      // "checking" is itself informative.
      return (
        <p className="settings-field-hint">
          {SETTINGS_STRINGS.memoryLoadingLine}
        </p>
      );
    case "unauthenticated":
      return <SignedOutNotice />;
    case "error":
      return (
        <EmptyState
          icon={<CircleAlert />}
          title={SETTINGS_STRINGS.memoryErrorTitle}
          description={query.message}
          action={
            <Button variant="outline" onClick={query.retry}>
              {SETTINGS_STRINGS.memoryCheckAgainAction}
            </Button>
          }
        />
      );
    case "ready":
      // A caller with no memory here gets the explanation, and the plane's
      // facts ride back as `null` for them — the server never describes a
      // store they have no reach into.
      if (query.data.caller.kind === "unscoped" || query.data.plane === null) {
        return (
          <UnscopedNotice
            reason={
              query.data.caller.kind === "unscoped"
                ? query.data.caller.reason
                : "no-org-principal"
            }
          />
        );
      }
      return (
        <SettingsPanel
          title={SETTINGS_STRINGS.memorySectionTitle}
          description={SETTINGS_STRINGS.memorySectionDescription}
        >
          <MemoryStatusBody data={query.data.plane} />
        </SettingsPanel>
      );
  }
}

/**
 * Holding no memory under this org is a fact about who is asking, not a
 * fault — so it reads as an explanation with no retry button, never as the
 * infrastructure error that a bare 403 used to surface as.
 */
function UnscopedNotice({
  reason,
}: {
  readonly reason: Extract<MemoryCallerScope, { kind: "unscoped" }>["reason"];
}) {
  const copy = {
    "no-org-principal": {
      title: SETTINGS_STRINGS.memoryGuestTitle,
      description: SETTINGS_STRINGS.memoryGuestDescription,
    },
    "no-account-tenant": {
      title: SETTINGS_STRINGS.memoryNoAccountTitle,
      description: SETTINGS_STRINGS.memoryNoAccountDescription,
    },
    "not-a-person": {
      title: SETTINGS_STRINGS.memoryNotAPersonTitle,
      description: SETTINGS_STRINGS.memoryNotAPersonDescription,
    },
  }[reason];

  return <EmptyState title={copy.title} description={copy.description} />;
}

function sourceCaption(data: MemoryPlaneStatus): string | null {
  if (!data.embeddingsConfigured) return null;
  if (data.source === "env") return SETTINGS_STRINGS.memorySourceEnvCaption;
  return null;
}

function MemoryStatusBody({ data }: { readonly data: MemoryPlaneStatus }) {
  const alarms = activeAlarms(data.degrade);
  const caption = sourceCaption(data);

  return (
    <>
      <div className="settings-connection-row-text">
        <div className="settings-connection-row-name-row">
          <span className="settings-connection-row-name">
            {data.embeddingsConfigured
              ? SETTINGS_STRINGS.memoryHeadlineSemantic
              : SETTINGS_STRINGS.memoryHeadlineLexical}
          </span>
          <span className="settings-connection-row-status">
            {data.embeddingsConfigured
              ? SETTINGS_STRINGS.memoryStatusWorking
              : SETTINGS_STRINGS.memoryStatusWorkingWordSearch}
          </span>
        </div>
        {caption !== null && (
          <p className="settings-connection-row-caption">{caption}</p>
        )}
      </div>

      {alarms.length > 0 && (
        <p className="settings-inline-error" role="alert">
          {SETTINGS_STRINGS.memorySearchIssuesTitle}
          {": "}
          {alarms
            .map((flag) => MEMORY_DEGRADE_FLAG_LABEL[flag] ?? flag)
            .join("; ")}
        </p>
      )}

      {!data.embeddingsConfigured && data.setupOptions.length > 0 && (
        <div>
          <h3 className="settings-subhead">
            {SETTINGS_STRINGS.memorySetupHeading}
          </h3>
          <div className="settings-connections-list">
            {data.setupOptions.map((option) => (
              <SetupOptionRow key={option.kind} option={option} />
            ))}
          </div>
        </div>
      )}

      <details className="settings-advanced-disclosure">
        <summary>
          <ChevronRight
            size={14}
            aria-hidden
            className="settings-advanced-disclosure-chevron"
          />
          {SETTINGS_STRINGS.memoryDetailsHeading}
        </summary>
        <div className="settings-advanced-disclosure-body">
          <dl className="settings-detail-list">
            {data.embed !== null && (
              <>
                <dt>{SETTINGS_STRINGS.memoryDetailsEmbedModelLabel}</dt>
                <dd>{data.embed.model}</dd>
                <dt>{SETTINGS_STRINGS.memoryDetailsHostLabel}</dt>
                <dd>{data.embed.host}</dd>
              </>
            )}
            <dt>{SETTINGS_STRINGS.memoryDetailsRerankModelLabel}</dt>
            <dd>
              {data.rerank.configured
                ? `${data.rerank.model} (${data.rerank.host})`
                : SETTINGS_STRINGS.memoryDetailsRerankNotSetUp}
            </dd>
            {data.missing.length > 0 && (
              <>
                <dt>{SETTINGS_STRINGS.memoryDetailsMissingLabel}</dt>
                <dd>{data.missing.join("; ")}</dd>
              </>
            )}
          </dl>
          <h3 className="settings-subhead settings-subhead-quiet">
            {SETTINGS_STRINGS.memoryDetailsSearchStatsHeading}
          </h3>
          <p className="settings-field-hint">
            {SETTINGS_STRINGS.memoryDetailsTotalSearches(
              data.degrade.totalSearches,
              formatSince(data.degrade.since),
            )}
          </p>
          <p className="settings-field-hint">
            {SETTINGS_STRINGS.memoryDetailsWindowSize(data.degrade.windowSize)}
          </p>
          {MEMORY_ALARM_DEGRADE_FLAGS.map((flag) => (
            <p key={flag} className="settings-field-hint">
              {SETTINGS_STRINGS.memoryDetailsRateLine(
                MEMORY_DEGRADE_FLAG_LABEL[flag] ?? flag,
                formatPercent(data.degrade.windowedDegradeRate[flag] ?? 0),
              )}
            </p>
          ))}
        </div>
      </details>
    </>
  );
}

function SetupOptionRow({ option }: { readonly option: MemorySetupOption }) {
  if (option.kind === "set-env") {
    return (
      <div className="settings-connection-row settings-connection-row-muted">
        <div className="settings-connection-row-text">
          <div className="settings-connection-row-name-row">
            <span className="settings-connection-row-name">{option.label}</span>
          </div>
          <p className="settings-connection-row-caption">
            {SETTINGS_STRINGS.memorySetupEnvVarsPrefix}
            {option.envVars.join(", ")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-connection-row">
      <div className="settings-connection-row-text">
        <div className="settings-connection-row-name-row">
          <span className="settings-connection-row-name">{option.label}</span>
          <span className="settings-connection-row-status">
            {SETTINGS_STRINGS.memorySetupActiveBadge}
          </span>
        </div>
        <p className="settings-connection-row-caption">{option.caveat}</p>
      </div>
    </div>
  );
}
