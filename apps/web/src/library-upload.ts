// The shell may fire this before LibraryPage is mounted; off-route it
// records a one-shot pending flag the page consumes on mount.

export const LIBRARY_UPLOAD_EVENT = "workbench:library:upload";

let pendingUpload = false;

// Off-route sets a pending flag and navigates, avoiding a setTimeout race.
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
