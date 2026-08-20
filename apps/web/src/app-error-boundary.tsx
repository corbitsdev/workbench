// The last line of defence (CL-6381): a render error anywhere in the tree
// used to leave the reader staring at a blank white page. React only offers
// this as a class component (no hook equivalent exists), so it's the one
// class in an otherwise function-component codebase.

import { getLogger } from "@corbits/client-log";
import { Button, EmptyState } from "@corbits/react-ui";
import { BoldIconProvider, WarningCircle } from "@corbits/icons";
import { Component, type ErrorInfo, type ReactNode } from "react";

const log = getLogger("web.app-error-boundary");

export class AppErrorBoundary extends Component<
  { readonly children: ReactNode },
  { readonly hasError: boolean }
> {
  override state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error(error.message, {
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <BoldIconProvider>
        <div className="app-boot-frame">
          <EmptyState
            icon={<WarningCircle />}
            title="This screen hit a snag"
            description="Something broke while rendering. Reloading usually fixes it."
            action={
              <Button
                variant="outline"
                onClick={() => window.location.reload()}
              >
                Reload
              </Button>
            }
          />
        </div>
      </BoldIconProvider>
    );
  }
}
