// The Granola inbound-webhook connector card (CL-6028). Workbench is the
// secret *issuer* here — the reverse of the `granola` api-key connector
// above it in the grid, which stores a key Granola issued. This card
// surfaces `@corbits/webhook-triggers`' existing mint/rotate machinery
// against the tenant's `granola-call` routine(s): no new secret code, no
// new backend route, just the Connections-surface view of an existing
// binding.
//
// "Granola-ish" means bound to the `granola-call` workflow definition
// specifically — the one automatable Granola workflow in
// `@corbits/workflow-catalog` (`process-granola-call` is a child run,
// never a routine). A routine picker is deliberately not built: with
// exactly one candidate workflow, offering a picker over a list of one
// would be UI theater, not a real choice.

import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  formatRelativeTime,
  Skeleton,
} from "@corbits/react-ui";
import type { ConnectorDescriptor } from "@workbench/connections/registry";
import { CircleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  bindRoutineWebhookTrigger,
  createGranolaWebhookTrigger,
  listGranolaRoutines,
  listGranolaWebhookTriggers,
  listGranolaWorkflowDefinitions,
  rotateGranolaWebhookTriggerSecret,
  sampleGranolaWebhookPayload,
  webhookTriggerUrl,
  type GranolaRoutine,
  type GranolaWebhookTrigger,
} from "./granola-webhook-api";
import { errorMessage, type LoadState } from "./load-state";
import { SETTINGS_STRINGS } from "./strings";
import { WebhookSecretPanel } from "./webhook-secret-panel";

/** The one automatable Granola workflow — see this file's header comment. */
const GRANOLA_WORKFLOW_ASSET_NAME = "granola-call";

type GranolaBinding = {
  readonly routine: GranolaRoutine;
  readonly webhookTrigger: GranolaWebhookTrigger | null;
};

type GranolaWebhookData = {
  readonly bindings: readonly GranolaBinding[];
};

function boundTriggers(
  bindings: readonly GranolaBinding[],
): readonly GranolaWebhookTrigger[] {
  return bindings
    .map((binding) => binding.webhookTrigger)
    .filter((trigger): trigger is GranolaWebhookTrigger => trigger !== null);
}

function mostRecentFiredAt(
  triggers: readonly GranolaWebhookTrigger[],
): string | null {
  const fired = triggers
    .map((trigger) => trigger.lastFiredAt)
    .filter((value): value is string => value !== null)
    .sort();
  return fired.length === 0 ? null : (fired[fired.length - 1] ?? null);
}

async function loadGranolaWebhookData(
  tenantId: string,
): Promise<GranolaWebhookData> {
  const [routines, definitions, triggers] = await Promise.all([
    listGranolaRoutines(tenantId),
    listGranolaWorkflowDefinitions(tenantId),
    listGranolaWebhookTriggers(tenantId),
  ]);
  const granolaDefinitionIds = new Set(
    definitions
      .filter((definition) => definition.name === GRANOLA_WORKFLOW_ASSET_NAME)
      .map((definition) => definition.id),
  );
  const granolaRoutines = routines.filter((routine) =>
    granolaDefinitionIds.has(routine.definitionId),
  );
  const triggersById = new Map(
    triggers.map((trigger) => [trigger.id, trigger]),
  );
  const bindings = granolaRoutines.map((routine) => ({
    routine,
    webhookTrigger:
      routine.trigger !== null && routine.trigger.kind === "webhook"
        ? (triggersById.get(routine.trigger.webhookTriggerId) ?? null)
        : null,
  }));
  return { bindings };
}

export function GranolaWebhookCard({
  tenantId,
  descriptor,
}: {
  readonly tenantId: string;
  readonly descriptor: ConnectorDescriptor;
}) {
  const [state, setState] = useState<LoadState<GranolaWebhookData>>({
    kind: "loading",
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  // A reload after a create/rotate refreshes the card's data in the
  // background — it must never flip the tree back through "loading",
  // which would unmount `GranolaWebhookDialog` and lose the just-revealed
  // secret it's showing.
  const loadedOnceRef = useRef(false);

  useEffect(() => {
    loadedOnceRef.current = false;
  }, [tenantId]);

  useEffect(() => {
    let cancelled = false;
    if (!loadedOnceRef.current) setState({ kind: "loading" });
    loadGranolaWebhookData(tenantId)
      .then((data) => {
        if (cancelled) return;
        loadedOnceRef.current = true;
        setState({ kind: "ready", data });
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setState({ kind: "error", message: errorMessage(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, reloadKey]);

  function reload() {
    setReloadKey((value) => value + 1);
  }

  if (state.kind === "loading") {
    return <Skeleton className="settings-connection-card" />;
  }
  if (state.kind === "error") {
    return (
      <div className="settings-connection-card">
        <span className="settings-connection-card-title">
          {descriptor.displayName}
        </span>
        <EmptyState
          icon={<CircleAlert />}
          title={SETTINGS_STRINGS.connectionsWebhookLoadError}
          description={state.message}
        />
      </div>
    );
  }

  const triggers = boundTriggers(state.data.bindings);
  const connected = triggers.length > 0;
  const lastFiredAt = mostRecentFiredAt(triggers);

  return (
    <>
      <div className="settings-connection-card">
        <span className="settings-connection-card-title">
          {descriptor.displayName}
        </span>
        <Badge tone={connected ? "success" : "neutral"}>
          {connected
            ? SETTINGS_STRINGS.connectionsStatusConnected
            : SETTINGS_STRINGS.connectionsWebhookNotSetUp}
        </Badge>
        {connected && (
          <span className="settings-connection-card-name">
            {SETTINGS_STRINGS.connectionsWebhookTriggerCount(triggers.length)} ·{" "}
            {lastFiredAt !== null
              ? SETTINGS_STRINGS.connectionsWebhookLastDelivery(
                  formatRelativeTime(lastFiredAt),
                )
              : SETTINGS_STRINGS.connectionsWebhookNoDeliveries}
          </span>
        )}
        <span className="settings-connection-card-pinned">
          {SETTINGS_STRINGS.connectionsWebhookDirectionNote}
        </span>
        <div className="settings-connection-card-actions">
          <Button
            variant="primary"
            size="sm"
            onClick={() => setDialogOpen(true)}
          >
            {connected
              ? SETTINGS_STRINGS.connectionsWebhookManageAction
              : SETTINGS_STRINGS.connectionsWebhookSetUpAction}
          </Button>
        </div>
      </div>
      <GranolaWebhookDialog
        open={dialogOpen}
        tenantId={tenantId}
        bindings={state.data.bindings}
        onClose={() => setDialogOpen(false)}
        onChanged={reload}
      />
    </>
  );
}

type RevealedSecret = {
  readonly routineId: string;
  readonly url: string;
  readonly secret: string;
};

function GranolaWebhookDialog({
  open,
  tenantId,
  bindings,
  onClose,
  onChanged,
}: {
  readonly open: boolean;
  readonly tenantId: string;
  readonly bindings: readonly GranolaBinding[];
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);
  const [busyRoutineId, setBusyRoutineId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setRevealed(null);
      setError(null);
      setBusyRoutineId(null);
    }
  }, [open]);

  function handleCreate(routine: GranolaRoutine) {
    setBusyRoutineId(routine.id);
    setError(null);
    createGranolaWebhookTrigger(tenantId, routine.definitionId, routine.name)
      .then((created) =>
        bindRoutineWebhookTrigger(tenantId, routine.id, created.id).then(
          () => created,
        ),
      )
      .then((created) => {
        setRevealed({
          routineId: routine.id,
          url: webhookTriggerUrl(created.id),
          secret: created.secret,
        });
        onChanged();
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setBusyRoutineId(null));
  }

  function handleRotate(binding: GranolaBinding) {
    const webhookTrigger = binding.webhookTrigger;
    if (webhookTrigger === null) return;
    setBusyRoutineId(binding.routine.id);
    setError(null);
    rotateGranolaWebhookTriggerSecret(tenantId, webhookTrigger.id)
      .then((rotated) => {
        setRevealed({
          routineId: binding.routine.id,
          url: webhookTriggerUrl(rotated.id),
          secret: rotated.secret,
        });
        onChanged();
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setBusyRoutineId(null));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {SETTINGS_STRINGS.connectionsWebhookDialogTitle}
          </DialogTitle>
          <DialogDescription>
            {SETTINGS_STRINGS.connectionsWebhookDialogDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="settings-form-stack">
          {bindings.length === 0 ? (
            <p className="settings-inline-hint">
              {SETTINGS_STRINGS.connectionsWebhookNoRoutine}
            </p>
          ) : (
            bindings.map((binding) => (
              <div
                key={binding.routine.id}
                className="settings-webhook-routine-row"
              >
                <div className="settings-webhook-routine-row-header">
                  <span className="settings-connection-card-title">
                    {binding.routine.name}
                  </span>
                  {binding.webhookTrigger !== null && (
                    <span className="settings-connection-card-name">
                      {binding.webhookTrigger.lastFiredAt !== null
                        ? SETTINGS_STRINGS.connectionsWebhookLastDelivery(
                            formatRelativeTime(
                              binding.webhookTrigger.lastFiredAt,
                            ),
                          )
                        : SETTINGS_STRINGS.connectionsWebhookNoDeliveries}
                    </span>
                  )}
                </div>
                {revealed?.routineId === binding.routine.id ? (
                  <WebhookSecretPanel
                    url={revealed.url}
                    secret={revealed.secret}
                    samplePayload={sampleGranolaWebhookPayload()}
                  />
                ) : binding.webhookTrigger === null ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    disabled={busyRoutineId === binding.routine.id}
                    onClick={() => handleCreate(binding.routine)}
                  >
                    {busyRoutineId === binding.routine.id
                      ? SETTINGS_STRINGS.connectionsSaving
                      : SETTINGS_STRINGS.connectionsWebhookCreateAction}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busyRoutineId === binding.routine.id}
                    onClick={() => handleRotate(binding)}
                  >
                    {busyRoutineId === binding.routine.id
                      ? SETTINGS_STRINGS.connectionsWebhookRotating
                      : SETTINGS_STRINGS.connectionsWebhookRotateAction}
                  </Button>
                )}
              </div>
            ))
          )}
          {error !== null && (
            <p className="settings-inline-error" role="alert">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {SETTINGS_STRINGS.connectionsCancel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
