// The last line of defence (CL-6381): a render error anywhere in the tree
// used to leave the reader staring at a blank white page. React only offers
// this as a class component (no hook equivalent exists), so it's the one
// class in an otherwise function-component codebase.

import { reportError } from "@corbits/error-sink";
import { Button, EmptyState } from "@corbits/react-ui";
import { BoldIconProvider, WarningCircle } from "@corbits/icons";
import { Component, type ErrorInfo, type ReactNode } from "react";

export class AppErrorBoundary extends Component<
  { readonly children: ReactNode },
  { readonly hasError: boolean; readonly refId?: string }
> {
  override state: { readonly hasError: boolean; readonly refId?: string } = {
    hasError: false,
  };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const refId = reportError(error, {
      operation: "app_render",
      extra: {
        ...(info.componentStack !== null
          ? { componentStack: info.componentStack }
          : {}),
      },
    });
    this.setState({ hasError: true, refId });
  }

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <BoldIconProvider>
        <div className="app-boot-frame">
          <EmptyState
            icon={<WarningCircle />}
            title="This screen hit a snag"
            description={
              this.state.refId === undefined ? (
                "Something broke while rendering. Reloading usually fixes it."
              ) : (
                <>
                  Something broke while rendering. Reloading usually fixes it.
                  <br />
                  <span className="app-boot-frame-refid">
                    Reference: {this.state.refId}
                  </span>
                </>
              )
            }
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
