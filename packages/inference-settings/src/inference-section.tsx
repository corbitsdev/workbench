// The workbench Inference section (CL-6099 workstream 2): the effective,
// ordered model/provider fallback list this exact conversation's tenant
// would launch against, each row's provenance ("workbench default"
// vs "set here"), and the native writes a member can make against it —
// move a set-here offering up/down (priority), restrict it, or bring this
// workbench's own key for an inherited offering so it becomes editable.
// Every write goes through `api.ts`'s native catalog routes; nothing here
// is a second store of "what this workbench prefers."

import {
  Badge,
  Button,
  EmptyState,
  Input,
  Skeleton,
  toast,
} from "@corbits/react-ui";
import { CircleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ModelOfferingResponse } from "@intx/types";

import {
  getResolvedCatalog,
  InferenceSettingsApiError,
  listOwnOfferings,
  shadowOffering,
  updateOwnOffering,
  type ModelInfo,
} from "./api";
import {
  buildEffectiveInferenceRows,
  restrictedOfferings,
  rowsByModel,
  swapPriority,
  type EffectiveInferenceRow,
} from "./effective-list";
import { CATALOG_SEEDS } from "@workbench/hub-client/catalog-seed-data";

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly models: readonly ModelInfo[];
      readonly ownOfferings: readonly (typeof ModelOfferingResponse.infer)[];
    };

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof InferenceSettingsApiError ? cause.message : fallback;
}

const KNOWN_PROVIDER_NAMES = Object.keys(CATALOG_SEEDS);

export function InferenceSection({
  tenantId,
}: {
  readonly tenantId: string;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [busyOfferingId, setBusyOfferingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [shadowTarget, setShadowTarget] = useState<EffectiveInferenceRow | null>(
    null,
  );

  function load() {
    setState({ kind: "loading" });
    Promise.all([getResolvedCatalog(tenantId), listOwnOfferings(tenantId)])
      .then(([models, ownOfferings]) => {
        setState({ kind: "ready", models, ownOfferings });
      })
      .catch((cause: unknown) => {
        setState({
          kind: "error",
          message: errorMessage(cause, "Couldn't load the inference catalog."),
        });
      });
  }

  useEffect(load, [tenantId]);

  const rows = useMemo(
    () =>
      state.kind === "ready"
        ? buildEffectiveInferenceRows(
            state.models,
            new Set(state.ownOfferings.map((o) => o.id)),
          )
        : [],
    [state],
  );
  const grouped = useMemo(() => rowsByModel(rows), [rows]);
  const restricted = useMemo(
    () => (state.kind === "ready" ? restrictedOfferings(state.ownOfferings) : []),
    [state],
  );

  if (state.kind === "loading") return <Skeleton className="query-skeleton" />;
  if (state.kind === "error") {
    return (
      <EmptyState
        icon={<CircleAlert />}
        title="Couldn't load Inference"
        description={state.message}
      />
    );
  }

  function handleReorder(
    model: readonly EffectiveInferenceRow[],
    index: number,
    direction: "up" | "down",
  ) {
    const otherIndex = direction === "up" ? index - 1 : index + 1;
    const moved = model[index];
    const neighbor = model[otherIndex];
    if (moved === undefined || neighbor === undefined) return;
    if (moved.provenance !== "set-here" || neighbor.provenance !== "set-here") {
      return;
    }
    const [movedPatch, neighborPatch] = swapPriority(moved, neighbor);
    setBusyOfferingId(moved.offeringId);
    setRowError(null);
    Promise.all([
      updateOwnOffering(tenantId, movedPatch.offeringId, {
        priority: movedPatch.priority,
      }),
      updateOwnOffering(tenantId, neighborPatch.offeringId, {
        priority: neighborPatch.priority,
      }),
    ])
      .then(() => load())
      .catch((cause: unknown) =>
        setRowError(errorMessage(cause, "Couldn't reorder that offering.")),
      )
      .finally(() => setBusyOfferingId(null));
  }

  function handleRestrict(row: EffectiveInferenceRow) {
    setBusyOfferingId(row.offeringId);
    setRowError(null);
    updateOwnOffering(tenantId, row.offeringId, { disabled: true })
      .then(() => load())
      .catch((cause: unknown) =>
        setRowError(errorMessage(cause, "Couldn't restrict that offering.")),
      )
      .finally(() => setBusyOfferingId(null));
  }

  function handleUnrestrict(offeringId: string) {
    setBusyOfferingId(offeringId);
    setRowError(null);
    updateOwnOffering(tenantId, offeringId, { disabled: false })
      .then(() => load())
      .catch((cause: unknown) =>
        setRowError(errorMessage(cause, "Couldn't restore that offering.")),
      )
      .finally(() => setBusyOfferingId(null));
  }

  return (
    <div className="channel-settings-pane">
      <p className="chat-settings-field-hint">
        The order below is the fallback order this workbench launches
        against: the first provider for a model is tried first. A provider
        marked "Set here" is this workbench's own — reorder or restrict it
        directly. A provider marked "Workbench default" is only
        editable once this workbench brings its own key for it.
      </p>
      {rowError !== null ? (
        <p className="chat-dialog-error" role="alert">
          {rowError}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title="No models in the catalog"
          description="Connect a provider in Keys & plugins to populate this workbench's inference catalog."
        />
      ) : (
        [...grouped.entries()].map(([modelId, modelRows]) => (
          <div key={modelId} className="chat-settings-callout">
            <strong>
              {modelRows[0]?.modelDisplayName ?? modelRows[0]?.canonicalName}
            </strong>
            <table className="settings-connections-grid" role="table">
              <tbody>
                {modelRows.map((row, index) => (
                  <tr key={row.offeringId}>
                    <td>{row.providerName}</td>
                    <td>
                      <Badge tone={row.provenance === "set-here" ? "success" : "neutral"}>
                        {row.provenance === "set-here"
                          ? "Set here"
                          : "Workbench default"}
                      </Badge>
                    </td>
                    <td>
                      {row.provenance === "set-here" ? (
                        <div className="settings-connection-card-actions">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={index === 0 || busyOfferingId !== null}
                            onClick={() =>
                              handleReorder(modelRows, index, "up")
                            }
                          >
                            Move up
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={
                              index === modelRows.length - 1 ||
                              busyOfferingId !== null
                            }
                            onClick={() =>
                              handleReorder(modelRows, index, "down")
                            }
                          >
                            Move down
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={busyOfferingId !== null}
                            onClick={() => handleRestrict(row)}
                          >
                            Restrict
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={busyOfferingId !== null}
                          onClick={() => setShadowTarget(row)}
                        >
                          Bring your own key
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}

      {restricted.length > 0 ? (
        <div className="chat-settings-callout">
          <strong>Restricted here</strong>
          <p className="chat-settings-field-hint">
            These providers are hidden from this workbench's fallback list.
          </p>
          {restricted.map((offering) => (
            <div
              key={offering.id}
              className="settings-connection-card-actions"
            >
              <span>{offering.id}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={busyOfferingId !== null}
                onClick={() => handleUnrestrict(offering.id)}
              >
                Restore
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      <ShadowOfferingDialog
        tenantId={tenantId}
        row={shadowTarget}
        priority={
          shadowTarget === null
            ? 0
            : (grouped.get(shadowTarget.modelId)?.length ?? 0)
        }
        onClose={() => setShadowTarget(null)}
        onDone={() => {
          setShadowTarget(null);
          load();
          toast("Saved. This workbench now controls that provider.");
        }}
      />
    </div>
  );
}

function ShadowOfferingDialog({
  tenantId,
  row,
  priority,
  onClose,
  onDone,
}: {
  readonly tenantId: string;
  readonly row: EffectiveInferenceRow | null;
  readonly priority: number;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setApiKey("");
    setError(null);
    setSubmitting(false);
    if (row === null) {
      setBaseURL("");
      return;
    }
    const seed = KNOWN_PROVIDER_NAMES.includes(row.providerName)
      ? CATALOG_SEEDS[row.providerName as keyof typeof CATALOG_SEEDS]
      : undefined;
    setBaseURL(seed?.provider.baseURL ?? "");
  }, [row]);

  if (row === null) return null;

  function handleSubmit() {
    if (row === null || apiKey.trim() === "" || baseURL.trim() === "") return;
    setSubmitting(true);
    setError(null);
    shadowOffering(tenantId, {
      canonicalName: row.canonicalName,
      providerName: row.providerName,
      plugin: row.plugin as Parameters<typeof shadowOffering>[1]["plugin"],
      baseURL: baseURL.trim(),
      apiKey: apiKey.trim(),
      priority,
    })
      .then(() => onDone())
      .catch((cause: unknown) =>
        setError(errorMessage(cause, "Couldn't save that key.")),
      )
      .finally(() => setSubmitting(false));
  }

  return (
    <div className="chat-settings-callout" role="dialog" aria-modal="true">
      <strong>Bring your own key for {row.providerName}</strong>
      <p className="chat-settings-field-hint">
        This creates {row.canonicalName} on {row.providerName} as this
        workbench's own catalog entry, using a key only this workbench
        holds — the workbench default's key is never reused.
      </p>
      <label className="settings-form-field">
        <span>Base URL</span>
        <Input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
      </label>
      <label className="settings-form-field">
        <span>API key</span>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
        />
      </label>
      {error !== null ? (
        <p className="settings-inline-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="settings-connection-card-actions">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={submitting || apiKey.trim() === "" || baseURL.trim() === ""}
          onClick={handleSubmit}
        >
          {submitting ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
