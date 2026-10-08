import { ThinkingLabel, ThinkingMark } from "@corbits/react-ui";

import "./working-label.css";

const VERBS = ["Thinking…", "Working on it…"];

// Shown under the last message while the worker has a turn open.
export function WorkingLabel() {
  return (
    <div className="chat-thread-working">
      <ThinkingMark variant="silk" className="chat-thread-working-mark" />
      <ThinkingLabel verbs={VERBS} intervalMs={3000} />
    </div>
  );
}
