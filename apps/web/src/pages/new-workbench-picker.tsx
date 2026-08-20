// Screen 1 of the approved mock (CL-6342): one row list, no card grid, no
// second "or start blank" branch underneath it — "Just start talking" is a
// peer row, not a fallback. A row is always selected on entry (the mock's
// "Code review" default), so the primary button stays enabled the whole
// time. Picking "Code review" instantiates the real template (CL-6344):
// the reviewer roster's agent definitions and the room's own opening
// intro — see `createWorkbenchFromTemplate`'s own doc for exactly what
// that does and doesn't do yet (the GitHub connect card itself is the
// next slice).

import { Button, toast } from "@corbits/react-ui";
import { ChatCircle, GitPullRequest, Plus } from "@corbits/icons";
import { WorkbenchLoadingState } from "@corbits/chat-ui";
import { useState } from "react";

import { useBench } from "../bench-context";
import { createWorkbenchFromTemplate } from "../instant-agent-create";
import { useNavigate } from "../navigation";
import { StageTopBar } from "../shell/stage-top-bar";
import {
  COMING_SOON_ROW,
  WORKBENCH_TEMPLATES,
  type WorkbenchTemplateId,
} from "../workbench-templates";

const ROW_ICON: Record<WorkbenchTemplateId, typeof GitPullRequest> = {
  "code-review": GitPullRequest,
  blank: ChatCircle,
};

function ctaLabel(selected: boolean): string {
  return selected ? "Selected" : "Choose";
}

export function NewWorkbenchPickerRoute() {
  const navigate = useNavigate();
  const { selectedTenantId } = useBench();
  const [selectedId, setSelectedId] = useState<WorkbenchTemplateId>(
    WORKBENCH_TEMPLATES[0]?.id ?? "blank",
  );
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    if (selectedTenantId === null || creating) return;
    setCreating(true);
    try {
      await createWorkbenchFromTemplate(selectedTenantId, selectedId, navigate);
    } catch {
      toast("Couldn't create the workbench — try again.");
      setCreating(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        title="New workbench"
        actions={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => navigate("/")}
          >
            Cancel
          </Button>
        }
      />
      <div className="new-workbench-picker">
        {creating ? (
          <WorkbenchLoadingState title="Setting up your workbench…" />
        ) : (
          <>
            <h3>What should this workbench do?</h3>
            <p className="new-workbench-picker-sub">
              Pick one. You can change your mind later — nothing is locked in.
            </p>

            <div
              className="new-workbench-pick-list"
              role="radiogroup"
              aria-label="Workbench kind"
            >
              {WORKBENCH_TEMPLATES.map((template) => {
                const Icon = ROW_ICON[template.id];
                const selected = template.id === selectedId;
                return (
                  <button
                    key={template.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-selected={selected ? "true" : undefined}
                    className="new-workbench-pick-row"
                    onClick={() => setSelectedId(template.id)}
                  >
                    <span
                      className="new-workbench-pick-glyph"
                      aria-hidden="true"
                    >
                      <Icon size={16} strokeWidth={1.8} />
                    </span>
                    <span className="new-workbench-pick-text">
                      <span className="new-workbench-pick-title">
                        {template.title}
                      </span>
                      <span className="new-workbench-pick-promise">
                        {template.promise}
                      </span>
                    </span>
                    <span className="new-workbench-pick-cta">
                      {ctaLabel(selected)}
                    </span>
                  </button>
                );
              })}

              <span className="new-workbench-pick-row" aria-disabled="true">
                <span className="new-workbench-pick-glyph" aria-hidden="true">
                  <Plus size={16} strokeWidth={1.8} />
                </span>
                <span className="new-workbench-pick-text">
                  <span className="new-workbench-pick-title">
                    {COMING_SOON_ROW.title}
                  </span>
                  <span className="new-workbench-pick-promise">
                    {COMING_SOON_ROW.promise}
                  </span>
                </span>
                <span className="new-workbench-pick-cta">Coming</span>
              </span>
            </div>

            <div className="new-workbench-picker-foot">
              <Button
                type="button"
                onClick={() => void handleCreate()}
                disabled={creating || selectedTenantId === null}
              >
                Create workbench
              </Button>
              <span className="new-workbench-picker-foot-note">
                Takes about ten seconds.
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
