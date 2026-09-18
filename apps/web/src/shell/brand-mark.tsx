// Static, not the animated dither background: its grid needs real screen
// real estate this size doesn't have.

import { CorbitsMark } from "@corbits/react-ui";

/** Small and quiet — the mark is the brand moment now, not an orange rail. */
export function SidebarBrandMark() {
  return (
    <div className="shell-sidebar-brand-mark" aria-hidden="true">
      <CorbitsMark decorative className="shell-sidebar-brand-mark-icon" />
    </div>
  );
}
