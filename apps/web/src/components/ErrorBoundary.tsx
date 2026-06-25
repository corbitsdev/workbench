import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

// Class component because React only surfaces render-phase errors to class
// lifecycle methods (getDerivedStateFromError / componentDidCatch); hooks
// cannot catch them. Wraps server-derived render surfaces so a malformed
// payload degrades to a recoverable message instead of a blank screen.
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // No console logging in apps/web; the fallback is the user-facing signal.
  }

  handleReset = (): void => {
    this.setState({ hasError: false });
    this.props.onReset?.();
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[14px] font-medium text-text">
          Something went wrong displaying this view.
        </p>
        <p className="text-[13px] text-text-3">
          The data could not be rendered. Try again.
        </p>
        <button
          type="button"
          onClick={this.handleReset}
          className="rounded-[9px] border border-border px-4 py-2 text-[13px] font-medium text-text-2 transition-colors hover:bg-surface hover:text-text"
        >
          Try again
        </button>
      </div>
    );
  }
}
