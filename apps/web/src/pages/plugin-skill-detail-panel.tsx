// A skill's detail, docked on the right of the Plugins gallery (CL-6090):
// the same registry reads and mutations `SkillsPage` already
// calls (`../skills-api.ts`) — share/make private, restore an older
// version — just in the gallery's docked-panel shape instead of Settings'
// master-detail list. Nothing here forks that section; it is a second,
// smaller view over the same data.

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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  formatRelativeTime,
} from "@corbits/react-ui";
import { WorkbenchLoadingState } from "@corbits/chat-ui";
import { useEffect, useState } from "react";

import {
  listSkillVersions,
  loadSkill,
  restoreSkillVersion,
  setSkillScope,
  type SkillDetail,
  type SkillVersion,
} from "../skills-api";

type DetailState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly skill: SkillDetail;
      readonly versions: readonly SkillVersion[];
    }
  | { readonly status: "error"; readonly message: string };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function PluginSkillDetailPanel({
  tenantId,
  skillName,
  onClose,
  onChanged,
}: {
  readonly tenantId: string;
  readonly skillName: string | null;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const open = skillName !== null;

  useEffect(() => {
    if (skillName === null) return;
    let cancelled = false;
    setState({ status: "loading" });
    Promise.all([
      loadSkill(tenantId, skillName),
      listSkillVersions(tenantId, skillName),
    ])
      .then(([detail, versions]) => {
        if (!cancelled)
          setState({ status: "ready", skill: detail.skill, versions });
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setState({ status: "error", message: messageOf(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, skillName]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      onChanged();
      if (skillName !== null) {
        const [detail, versions] = await Promise.all([
          loadSkill(tenantId, skillName),
          listSkillVersions(tenantId, skillName),
        ]);
        setState({ status: "ready", skill: detail.skill, versions });
      }
    } catch (cause) {
      setState({ status: "error", message: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent side="right" key={skillName ?? "none"}>
        <DialogHeader>
          <DialogTitle>
            {state.status === "ready" ? state.skill.name : (skillName ?? "")}
          </DialogTitle>
          <DialogDescription>
            {state.status === "ready" ? state.skill.description : ""}
          </DialogDescription>
        </DialogHeader>
        {state.status === "loading" ? (
          <DialogBody>
            <WorkbenchLoadingState title="Loading skill…" />
          </DialogBody>
        ) : state.status === "error" ? (
          <DialogBody>
            <p className="text-sm text-destructive" role="alert">
              {state.message}
            </p>
          </DialogBody>
        ) : (
          <DialogBody className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Badge tone={state.skill.scope === "tenant" ? "info" : "neutral"}>
                {state.skill.scope === "tenant"
                  ? "Shared with everyone"
                  : "Just you"}
              </Badge>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    setSkillScope(
                      tenantId,
                      state.skill.name,
                      state.skill.scope === "tenant" ? "private" : "tenant",
                    ),
                  )
                }
              >
                {state.skill.scope === "tenant"
                  ? "Make private"
                  : "Share with everyone"}
              </Button>
            </div>
            <pre className="whitespace-pre-wrap break-words border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
              {state.skill.body}
            </pre>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.versions.map((version) => (
                  <TableRow key={version.commitSha}>
                    <TableCell className="font-mono text-xs">
                      {version.commitSha.slice(0, 8)}
                      {version.current ? (
                        <Badge tone="success" className="ml-2">
                          current
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">{version.message}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatRelativeTime(version.committedAtIso)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={version.current || busy}
                        onClick={() =>
                          void run(() =>
                            restoreSkillVersion(
                              tenantId,
                              state.skill.name,
                              version.commitSha,
                            ),
                          )
                        }
                      >
                        Restore
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DialogBody>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
