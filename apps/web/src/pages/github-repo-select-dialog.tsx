// CL-6386's "select on new-workbench" half: once GitHub is already
// connected (established from the Plugins page), the create flow reuses
// this dialog to let a person choose which repos this workbench can work
// on, right after the workbench is minted. It wires `ConnectGithubBlockView`
// wholesale — the same connected-state repo checklist the in-room
// connect-github card already renders — rather than forking its layout,
// so there is exactly one "pick repos" UI in this repo.

import { useState } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@corbits/react-ui";
import {
  ConnectGithubBlockView,
  type ConnectGithubRepo,
} from "@corbits/chat-ui";

export function GithubRepoSelectDialog({
  orgName,
  repos,
  initialSelectedRepoIds,
  onStartReviewing,
  onSkip,
}: {
  readonly orgName: string;
  readonly repos: readonly ConnectGithubRepo[];
  readonly initialSelectedRepoIds: readonly string[];
  readonly onStartReviewing: (repoIds: readonly string[]) => void;
  readonly onSkip: () => void;
}) {
  const [selectedRepoIds, setSelectedRepoIds] = useState<readonly string[]>(
    initialSelectedRepoIds,
  );

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onSkip();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Choose repos this workbench can work on</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <ConnectGithubBlockView
            kind="connected"
            orgName={orgName}
            repos={repos}
            selectedRepoIds={selectedRepoIds}
            onToggleRepo={(repoId) =>
              setSelectedRepoIds((current) =>
                current.includes(repoId)
                  ? current.filter((id) => id !== repoId)
                  : [...current, repoId],
              )
            }
            onSelectAll={() => setSelectedRepoIds(repos.map((repo) => repo.id))}
            onChangeConnection={onSkip}
            onStartReviewing={onStartReviewing}
            onSkip={onSkip}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
