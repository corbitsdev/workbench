// Approvals, fanned out per-bench: `GET /api/me/approvals` is a hub stub
// that always returns `[]` (see the tenancy inventory's gap list), so this
// reads the current bench's pending approvals from the real, tenant-scoped
// `GET /api/tenants/:tenantId/approvals` instead. Approve only offers scope
// "once" — the hub rejects "always" with a 400 because a standing grant
// needs the tool identity the suspend path doesn't capture yet — and reject
// collects an optional message before resolving.

import {
  ApprovalCard,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  PageShell,
  TopBar,
  TopBarTitle,
} from "@corbits/react-ui";
import type { ApprovalRequest } from "@corbits/react-ui";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";

import {
  approveApproval,
  rejectApproval,
  TenantApprovalsSchema,
  useAPIQuery,
} from "../api";
import { countProp } from "../optional-props";
import type { APIQuery, Approval } from "../api";
import { useBench } from "../bench-context";
import { QueryView } from "../query-view";

function approvalHeadline(approval: Approval): string {
  const toolName = approval.toolDefinition["name"];
  return typeof toolName === "string" ? toolName : "Run a tool";
}

export function ApprovalsPage({
  approvals,
  onApprove,
  onReject,
  approvingId = null,
  rejectingId = null,
  actionError = null,
}: {
  readonly approvals: APIQuery<Approval[]>;
  readonly onApprove: (approval: Approval) => void;
  readonly onReject: (approval: Approval, message?: string) => void;
  readonly approvingId?: string | null;
  readonly rejectingId?: string | null;
  readonly actionError?: string | null;
}) {
  const [rejectTarget, setRejectTarget] = useState<Approval | null>(null);

  return (
    <>
      <TopBar>
        <TopBarTitle
          {...countProp(
            approvals.kind === "ready" ? approvals.data.length : undefined,
          )}
          subtitle="Requests waiting on a human decision, on the current bench"
        >
          Approvals
        </TopBarTitle>
      </TopBar>
      <PageShell width="full" className="page-fill">
        <QueryView query={approvals} label="approvals">
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState
                icon={<ShieldCheck />}
                title="No approvals waiting"
                description="When a running workflow asks for permission to act, the request lands here with the tool and arguments it wants to run. Nothing is waiting on you right now."
              />
            ) : (
              <div className="approvals-list">
                {rows.map((approval) => {
                  const request: ApprovalRequest = {
                    id: approval.id,
                    headline: approvalHeadline(approval),
                    requestedBy: approval.agentAddress,
                    details: Object.entries(approval.toolArguments).map(
                      ([label, value]) => ({
                        label,
                        value:
                          typeof value === "string"
                            ? value
                            : JSON.stringify(value),
                      }),
                    ),
                  };
                  const state =
                    approvingId === approval.id
                      ? "approving"
                      : rejectingId === approval.id
                        ? "rejecting"
                        : "idle";
                  return (
                    <ApprovalCard
                      key={approval.id}
                      request={request}
                      onApprove={() => onApprove(approval)}
                      onReject={() => setRejectTarget(approval)}
                      state={state}
                      error={
                        (approvingId === approval.id ||
                          rejectingId === approval.id) &&
                        actionError !== null
                          ? actionError
                          : null
                      }
                    />
                  );
                })}
              </div>
            )
          }
        </QueryView>
      </PageShell>
      <RejectDialog
        approval={rejectTarget}
        onClose={() => setRejectTarget(null)}
        onConfirm={(message) => {
          if (rejectTarget !== null) onReject(rejectTarget, message);
          setRejectTarget(null);
        }}
      />
    </>
  );
}

function RejectDialog({
  approval,
  onClose,
  onConfirm,
}: {
  readonly approval: Approval | null;
  readonly onClose: () => void;
  readonly onConfirm: (message?: string) => void;
}) {
  const [message, setMessage] = useState("");

  return (
    <Dialog
      open={approval !== null}
      onOpenChange={(next) => {
        if (!next) {
          setMessage("");
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject this request?</DialogTitle>
          <DialogDescription>
            An optional message is sent back to the agent as feedback.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <textarea
            className="approvals-reject-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Why this is being rejected (optional)"
            rows={3}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() =>
              onConfirm(
                message.trim().length === 0 ? undefined : message.trim(),
              )
            }
          >
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ApprovalsRoute() {
  const { selectedTenantId } = useBench();
  const [reloadKey, setReloadKey] = useState(0);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const approvals = useAPIQuery(
    selectedTenantId === null
      ? ""
      : `/api/tenants/${selectedTenantId}/approvals`,
    TenantApprovalsSchema,
    reloadKey,
  );
  const rows: APIQuery<Approval[]> =
    selectedTenantId === null
      ? { kind: "loading" }
      : approvals.kind === "ready"
        ? { kind: "ready", data: approvals.data.data }
        : approvals;

  function reload() {
    setReloadKey((value) => value + 1);
  }

  function handleApprove(approval: Approval) {
    if (selectedTenantId === null) return;
    setActionError(null);
    setApprovingId(approval.id);
    approveApproval(selectedTenantId, approval.id)
      .then(reload)
      .catch(() => setActionError("Couldn't approve that request — try again."))
      .finally(() => setApprovingId(null));
  }

  function handleReject(approval: Approval, message?: string) {
    if (selectedTenantId === null) return;
    setActionError(null);
    setRejectingId(approval.id);
    rejectApproval(selectedTenantId, approval.id, message)
      .then(reload)
      .catch(() => setActionError("Couldn't reject that request — try again."))
      .finally(() => setRejectingId(null));
  }

  return (
    <ApprovalsPage
      approvals={rows}
      onApprove={handleApprove}
      onReject={handleReject}
      approvingId={approvingId}
      rejectingId={rejectingId}
      actionError={actionError}
    />
  );
}
