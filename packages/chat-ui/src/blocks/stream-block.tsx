import type { StreamBlockData } from "@corbits/chat/blocks";

import { BlockCard } from "./block-card";

export function StreamBlockView({ data }: { readonly data: StreamBlockData }) {
  return (
    <BlockCard title={data.title}>
      <pre className="chat-block-stream">
        {data.text}
        {!data.done && (
          <span className="chat-block-cursor" aria-hidden="true" />
        )}
      </pre>
    </BlockCard>
  );
}
