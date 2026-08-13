import type { MetricsBlockData } from "@corbits/chat/blocks";

import { BlockCard } from "./block-card";

export function MetricsBlockView({
  data,
}: {
  readonly data: MetricsBlockData;
}) {
  return (
    <BlockCard title={data.title}>
      <div className="chat-block-metrics">
        {data.metrics.map((metric, index) => (
          <div key={`${index}-${metric.label}`} className="chat-block-metric">
            <div className="chat-block-metric-label">{metric.label}</div>
            <div className="chat-block-metric-value">{metric.value}</div>
            {metric.detail !== undefined && (
              <div
                className="chat-block-metric-detail"
                data-trend={metric.trend}
              >
                {metric.detail}
              </div>
            )}
          </div>
        ))}
      </div>
      {data.bars !== undefined && (
        <div className="chat-block-bars">
          {data.bars.map((bar, index) => (
            <div key={`${index}-${bar.label}`} className="chat-block-bar-row">
              <span>{bar.label}</span>
              <span className="chat-block-bar" aria-hidden="true">
                <span
                  className="chat-block-bar-fill"
                  style={{ width: `${bar.percent}%` }}
                />
              </span>
              <span>{bar.percent}%</span>
            </div>
          ))}
        </div>
      )}
    </BlockCard>
  );
}
