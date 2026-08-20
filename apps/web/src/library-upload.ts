// Library pageBand Upload is a cross-route action: the shell may fire it from
// another path before LibraryPage is mounted. When already on /files, open
// the picker immediately; otherwise record a one-shot pending flag the page
// consumes on mount. Keeps shell ↔ page coupling to this tiny module.

export const LIBRARY_UPLOAD_EVENT = "workbench:library:upload";

let pendingUpload = false;

/**
 * Request the Library file picker. On-route: dispatch the window event the
 * mounted page listens for. Off-route: set a pending flag and navigate so the
 * page opens the picker after mount — no setTimeout race.
 */
export function requestLibraryUpload(args: {
  readonly alreadyOnLibrary: boolean;
  readonly navigateToLibrary: () => void;
}): void {
  if (args.alreadyOnLibrary) {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(LIBRARY_UPLOAD_EVENT));
    }
    return;
  }
  pendingUpload = true;
  args.navigateToLibrary();
}

/** True once if an off-route upload was requested; clears the flag. */
export function consumePendingLibraryUpload(): boolean {
  if (!pendingUpload) return false;
  pendingUpload = false;
  return true;
}

/** Test helper — drop leftover pending state between cases. */
export function resetPendingLibraryUpload(): void {
  pendingUpload = false;
}
