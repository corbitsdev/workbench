import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence } from "framer-motion";
import { ReconnectingOverlay } from "../components/ReconnectingOverlay";
import { useDelayedFlag } from "../hooks/use-delayed-flag";
import {
  isReconnecting,
  RECONNECT_OVERLAY_DELAY_MS,
  type ConnectionStatus,
} from "./connection-status";

/** A reporter drops its entry with `"gone"` on unmount. */
export type ReportedStatus = ConnectionStatus | "gone";

type Report = (id: string, status: ReportedStatus) => void;

// Default is a no-op so `useConnectionReporter` is safe outside a provider —
// notably in the many `useMyraSession` tests that do not mount the app shell.
const ConnectionReporterContext = createContext<Report>(() => {});

export function useConnectionReporter(): Report {
  return useContext(ConnectionReporterContext);
}

/**
 * Aggregates connection status across every active Myra session and covers the
 * app with the reconnecting overlay when one has been dropped long enough to
 * matter. Mount inside the authenticated shell so the overlay inherits the
 * app's theme tokens and branding.
 */
export function ConnectionStatusProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [statuses, setStatuses] = useState<
    ReadonlyMap<string, ConnectionStatus>
  >(new Map());

  const report = useCallback<Report>((id, status) => {
    setStatuses((prev) => {
      if (status === "gone") {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      }
      if (prev.get(id) === status) return prev;
      const next = new Map(prev);
      next.set(id, status);
      return next;
    });
  }, []);

  const reconnecting = useMemo(
    () => isReconnecting(statuses.values()),
    [statuses],
  );
  const visible = useDelayedFlag(reconnecting, RECONNECT_OVERLAY_DELAY_MS);

  // The overlay is a blocking cover: lock body scroll while it is up so the
  // inert app behind it cannot be scrolled.
  useEffect(() => {
    if (!visible) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [visible]);

  return (
    <ConnectionReporterContext.Provider value={report}>
      {/* Mark the app inert while covered so keyboard/AT users cannot reach the
          disconnected controls hidden behind the overlay. */}
      <div style={{ display: "contents" }} inert={visible}>
        {children}
      </div>
      <AnimatePresence>
        {visible && <ReconnectingOverlay key="reconnecting-overlay" />}
      </AnimatePresence>
    </ConnectionReporterContext.Provider>
  );
}
