import { motion } from "framer-motion";
import { WorkbenchBootScreen } from "./WorkbenchBootScreen";

/**
 * Full-screen cover shown while the app reconnects to a restarting hub/sidecar.
 * Reuses the shared Workbench boot screen with an "Updating Workbench" message,
 * wrapped so it fades in/out via the AnimatePresence in
 * ConnectionStatusProvider. The provider also locks scroll and marks the app
 * behind it inert while this is mounted.
 */
export function ReconnectingOverlay() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="fixed inset-0 z-[100]"
    >
      <WorkbenchBootScreen message="Updating Workbench" />
    </motion.div>
  );
}
