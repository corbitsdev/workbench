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
  ConfirmButton,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@corbits/react-ui";
import { CircleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { type } from "arktype";
import {
  ModelProviderPlugin,
  type ModelOfferingResponse,
  type ModelProviderResponse,
  type ModelResponse,
} from "@intx/types";

import {
  getResolvedCatalog,
  InferenceSettingsApiError,
  listOwnModelProviders,
  listOwnModels,
  listOwnOfferings,
  shadowOffering,
  updateOwnOffering,
  type ModelInfo,
} from "./api";
import {
  buildEffectiveInferenceRows,
  computeReorderPatches,
  restrictedOfferings,
  rowsByModel,
  type EffectiveInferenceRow,
} from "./effective-list";
import { INFERENCE_STRINGS } from "./strings";
import { CATALOG_SEEDS } from "@workbench/hub-client/catalog-seed-data";

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly models: readonly ModelInfo[];
      readonly ownOfferings: readonly (typeof ModelOfferingResponse.infer)[];
      readonly ownModels: readonly (typeof ModelResponse.infer)[];
      readonly ownProviders: readonly (typeof ModelProviderResponse.infer)[];
    };

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof InferenceSettingsApiError ? cause.message : fallback;
}

const KNOWN_PROVIDER_NAMES = Object.keys(CATALOG_SEEDS);

export function InferenceSection({ tenantId }: { readonly tenantId: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  // Busy state is scoped to the one offering a write is in flight for, so
  // an action on one model's row never dims another model's controls.
  const [busyOfferingId, setBusyOfferingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [shadowTarget, setShadowTarget] =
    useState<EffectiveInferenceRow | null>(null);

  function load() {
    setState({ kind: "loading" });
    Promise.all([
      getResolvedCatalog(tenantId),
      listOwnOfferings(tenantId),
      listOwnModels(tenantId),
      listOwnModelProviders(tenantId),
    ])
      .then(([models, ownOfferings, ownModels, ownProviders]) => {
        setState({
          kind: "ready",
          models,
          ownOfferings,
          ownModels,
          ownProviders,
        });
      })
      .catch((cause: unknown) => {
        setState({
          kind: "error",
          message: errorMessage(cause, INFERENCE_STRINGS.loadError),
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
    () =>
      state.kind === "ready" ? restrictedOfferings(state.ownOfferings) : [],
    [state],
  );
  const ownModelNameById = useMemo(
    () =>
      new Map(
        state.kind === "ready"
          ? state.ownModels.map((m) => [m.id, m.displayName ?? m.canonicalName])
          : [],
      ),
    [state],
  );
  const ownProviderNameById = useMemo(
    () =>
      new Map(
        state.kind === "ready"
          ? state.ownProviders.map((p) => [p.id, p.name])
          : [],
      ),
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
    const patches = computeReorderPatches(model, index, direction);
    if (patches === null) return;
    const [first, second] = patches;
    const originalByOfferingId = new Map(
      model.map((row) => [row.offeringId, row.priority]),
    );
    setBusyOfferingId(first.offeringId);
    setRowError(null);
    // Sequential, not Promise.all: on the second write's failure the first
    // is rolled back to its original priority, so a partial reorder never
    // leaves the fallback list in a state neither the old nor the new order
    // describes.
    updateOwnOffering(tenantId, first.offeringId, { priority: first.priority })
      .then(() =>
        updateOwnOffering(tenantId, second.offeringId, {
          priority: second.priority,
        }).catch(async (cause: unknown) => {
          const original = originalByOfferingId.get(first.offeringId);
          if (original !== undefined) {
            await updateOwnOffering(tenantId, first.offeringId, {
              priority: original,
            }).catch(() => undefined);
          }
          throw cause;
        }),
      )
      .then(() => load())
      .catch((cause: unknown) =>
        setRowError(errorMessage(cause, INFERENCE_STRINGS.reorderError)),
      )
      .finally(() => setBusyOfferingId(null));
  }

  function handleRestrict(row: EffectiveInferenceRow) {
    setBusyOfferingId(row.offeringId);
    setRowError(null);
    updateOwnOffering(tenantId, row.offeringId, { disabled: true })
      .then(() => load())
      .catch((cause: unknown) =>
        setRowError(errorMessage(cause, INFERENCE_STRINGS.restrictError)),
      )
      .finally(() => setBusyOfferingId(null));
  }

  function handleUnrestrict(offeringId: string) {
    setBusyOfferingId(offeringId);
    setRowError(null);
    updateOwnOffering(tenantId, offeringId, { disabled: false })
      .then(() => load())
      .catch((cause: unknown) =>
        setRowError(errorMessage(cause, INFERENCE_STRINGS.restoreError)),
      )
      .finally(() => setBusyOfferingId(null));
  }

  return (
    <div className="channel-settings-pane">
      <p className="chat-settings-field-hint">{INFERENCE_STRINGS.hint}</p>
      {rowError !== null ? (
        <p className="chat-dialog-error" role="alert">
          {rowError}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title={INFERENCE_STRINGS.emptyTitle}
          description={INFERENCE_STRINGS.emptyDescription}
        />
      ) : (
        [...grouped.entries()].map(([modelId, modelRows]) => (
          <div key={modelId} className="chat-settings-callout">
            <strong>
              {modelRows[0]?.modelDisplayName ?? modelRows[0]?.canonicalName}
            </strong>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{INFERENCE_STRINGS.columnProvider}</TableHead>
                  <TableHead>{INFERENCE_STRINGS.columnStatus}</TableHead>
                  <TableHead>{INFERENCE_STRINGS.columnActions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {modelRows.map((row, index) => {
                  const rowBusy = busyOfferingId !== null;
                  const upNeighbor = modelRows[index - 1];
                  const downNeighbor = modelRows[index + 1];
                  const upDisabled =
                    index === 0 ||
                    upNeighbor?.provenance !== "set-here" ||
                    rowBusy;
                  const downDisabled =
                    index === modelRows.length - 1 ||
                    downNeighbor?.provenance !== "set-here" ||
                    rowBusy;
                  const upTitle =
                    index === 0
                      ? INFERENCE_STRINGS.moveUpDisabledFirst
                      : upNeighbor?.provenance !== "set-here"
                        ? INFERENCE_STRINGS.moveDisabledNeighborInherited
                        : undefined;
                  const downTitle =
                    index === modelRows.length - 1
                      ? INFERENCE_STRINGS.moveDownDisabledLast
                      : downNeighbor?.provenance !== "set-here"
                        ? INFERENCE_STRINGS.moveDisabledNeighborInherited
                        : undefined;

                  return (
                    <TableRow key={row.offeringId}>
                      <TableCell>{row.providerName}</TableCell>
                      <TableCell>
                        <Badge
                          tone={
                            row.provenance === "set-here"
                              ? "success"
                              : "neutral"
                          }
                        >
                          {row.provenance === "set-here"
                            ? INFERENCE_STRINGS.provenanceSetHere
                            : INFERENCE_STRINGS.provenanceInherited}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {row.provenance === "set-here" ? (
                          <div className="settings-connection-card-actions">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={upDisabled}
                              title={upTitle}
                              onClick={() =>
                                handleReorder(modelRows, index, "up")
                              }
                            >
                              {INFERENCE_STRINGS.moveUp}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={downDisabled}
                              title={downTitle}
                              onClick={() =>
                                handleReorder(modelRows, index, "down")
                              }
                            >
                              {INFERENCE_STRINGS.moveDown}
                            </Button>
                            <ConfirmButton
                              variant="destructive"
                              size="sm"
                              disabled={rowBusy}
                              confirmLabel={INFERENCE_STRINGS.restrictConfirm}
                              onConfirm={() => handleRestrict(row)}
                            >
                              {INFERENCE_STRINGS.restrictAction}
                            </ConfirmButton>
                          </div>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={rowBusy}
                            onClick={() => setShadowTarget(row)}
                          >
                            {INFERENCE_STRINGS.byokAction}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ))
      )}

      {restricted.length > 0 ? (
        <div className="chat-settings-callout">
          <strong>{INFERENCE_STRINGS.restrictedSectionTitle}</strong>
          <p className="chat-settings-field-hint">
            {INFERENCE_STRINGS.restrictedSectionHint}
          </p>
          {restricted.map((offering) => (
            <div key={offering.id} className="settings-connection-card-actions">
              <span>
                {(ownModelNameById.get(offering.modelId) ?? offering.modelId) +
                  " · " +
                  (ownProviderNameById.get(offering.providerId) ??
                    offering.providerId)}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={busyOfferingId !== null}
                onClick={() => handleUnrestrict(offering.id)}
              >
                {INFERENCE_STRINGS.restoreAction}
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      <ShadowOfferingDialog
        tenantId={tenantId}
        row={shadowTarget}
        onClose={() => setShadowTarget(null)}
        onDone={() => {
          setShadowTarget(null);
          load();
          toast(INFERENCE_STRINGS.byokDoneToast);
        }}
      />
    </div>
  );
}

function ShadowOfferingDialog({
  tenantId,
  row,
  onClose,
  onDone,
}: {
  readonly tenantId: string;
  readonly row: EffectiveInferenceRow | null;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref-guard, not just `submitting` state: a second click that lands
  // in the same tick as the first (before the state update from
  // `setSubmitting(true)` has flushed and re-rendered the disabled
  // button) would otherwise still pass the `submitting` check and fire a
  // second mint chain.
  const submittingRef = useRef(false);

  useEffect(() => {
    setApiKey("");
    setError(null);
    setSubmitting(false);
    submittingRef.current = false;
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
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    const plugin = ModelProviderPlugin(row.plugin);
    if (plugin instanceof type.errors) {
      setError(INFERENCE_STRINGS.byokError);
      setSubmitting(false);
      submittingRef.current = false;
      return;
    }
    shadowOffering(tenantId, {
      canonicalName: row.canonicalName,
      modelDisplayName: row.modelDisplayName,
      providerName: row.providerName,
      plugin,
      baseURL: baseURL.trim(),
      apiKey: apiKey.trim(),
      priority: row.priority,
    })
      .then(() => onDone())
      .catch((cause: unknown) =>
        setError(errorMessage(cause, INFERENCE_STRINGS.byokError)),
      )
      .finally(() => {
        setSubmitting(false);
        submittingRef.current = false;
      });
  }

  return (
    <Dialog
      open={row !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {INFERENCE_STRINGS.byokDialogTitle(row.providerName)}
          </DialogTitle>
          <DialogDescription>
            {INFERENCE_STRINGS.byokDialogDescription(
              row.canonicalName,
              row.providerName,
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="settings-form-stack">
          <label className="settings-form-field">
            <span>{INFERENCE_STRINGS.byokBaseURLLabel}</span>
            <Input
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
            />
          </label>
          <label className="settings-form-field">
            <span>{INFERENCE_STRINGS.byokKeyLabel}</span>
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
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {INFERENCE_STRINGS.byokCancel}
          </Button>
          <Button
            variant="primary"
            disabled={
              submitting || apiKey.trim() === "" || baseURL.trim() === ""
            }
            onClick={handleSubmit}
          >
            {submitting
              ? INFERENCE_STRINGS.byokSubmitting
              : INFERENCE_STRINGS.byokSubmit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
