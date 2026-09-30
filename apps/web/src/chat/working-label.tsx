import { ThinkingLabel } from "@corbits/react-ui";

import "./working-label.css";

const VERBS = ["Thinking…", "Working on it…"];

// Shown under the last message while the worker has a turn open.
export function WorkingLabel() {
  return (
    <div className="chat-thread-working">
      <ThinkingLabel verbs={VERBS} intervalMs={3000} />
    </div>
  );
}
