// Thin mount: adapts the bench-selection state and the URL into the shape
// `@/settings`'s shell expects, and presents it over whatever page is behind.

import { flattenSettingsSections, resolveActiveSection, SettingsShell } from "@/settings";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@corbits/react-ui/ui/dialog";

import { useBench } from "../bench-context";
import { useSignOut } from "../navigation";
import { Redirect } from "../redirect";
import {
  SETTINGS_PATH_PREFIX,
  settingsEntityIdFromPath,
  settingsSectionIdFromPath,
} from "../path-ids";
import { resolveAppSettingsSectionGroups } from "../settings-groups";
import { SettingsNav } from "./settings-nav";
import "./settings-dialog.css";
import { useSettingsAccess } from "../settings-access";

export function SettingsDialog({
  path,
  navigate,
  onClose,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
  readonly onClose: () => void;
}) {
  const { selectedTenantId, selectedPrincipalId } = useBench();
  const onSignOut = useSignOut();
  const access = useSettingsAccess(selectedTenantId, selectedPrincipalId);
  const groups = resolveAppSettingsSectionGroups(access);
  const sections = flattenSettingsSections(groups);
  const requestedId = settingsSectionIdFromPath(path);
  const activeSection = resolveActiveSection(sections, requestedId);
  const entityId =
    activeSection === undefined ? null : settingsEntityIdFromPath(path, activeSection.id);
  const requestedSectionExists =
    requestedId !== null && sections.some((section) => section.id === requestedId);
  // Wait for every gate to settle before treating a miss as final, or a
  // deep link to an about-to-be-allowed section would bounce away early.
  const accessSettled =
    access.people !== "loading" &&
    access.roles !== "loading" &&
    access.grants !== "loading" &&
    access.credentials !== "loading";

  const activeSectionId = activeSection?.id ?? null;

  // Bare /settings, and an unknown or gate-denied /settings/:section, both
  // correct to the first allowed section's own URL — never a fallback
  // rendered under a URL the section nav disagrees with.
  if (
    activeSectionId !== null &&
    (requestedId === null || (!requestedSectionExists && accessSettled))
  ) {
    return (
      <Redirect to={`${SETTINGS_PATH_PREFIX}/${activeSectionId}`} from={path} navigate={navigate} />
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="settings-dialog" aria-describedby={undefined}>
        <DialogHeader className="settings-dialog-head">
          <DialogTitle className="settings-dialog-title">Settings</DialogTitle>
        </DialogHeader>
        <div className="settings-layout settings-dialog-layout">
          <SettingsNav path={path} onNavigate={navigate} />
          <DialogBody className="settings-dialog-body">
            <SettingsShell
              sections={sections}
              activeId={activeSection?.id ?? null}
              context={{
                tenantId: selectedTenantId,
                principalId: selectedPrincipalId,
                navigate,
                entityId,
                ...(onSignOut !== undefined ? { onSignOut } : {}),
              }}
            />
          </DialogBody>
        </div>
      </DialogContent>
    </Dialog>
  );
}
