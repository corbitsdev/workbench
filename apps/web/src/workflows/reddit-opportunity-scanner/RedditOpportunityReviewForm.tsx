import { useState } from 'react';
import type { RedditOpportunityScan } from '../../components/RedditOpportunityBody';
import { DEFAULT_SCAN_CONFIG } from '@workbench/gtm-workflows/reddit-opportunity-scanner';

type Recommendation = RedditOpportunityScan['recommendations']['keywords'][number];

function RecommendationList({
  title,
  items,
  onChange,
}: {
  title: string;
  items: Recommendation[];
  onChange: (next: Recommendation[]) => void;
}) {
  const [newLabel, setNewLabel] = useState('');

  const toggleSource = (index: number, source: Recommendation['source']) => {
    const next = items.map((item, i) => (i === index ? { ...item, source } : item));
    onChange(next);
  };

  const updateLabel = (index: number, label: string) => {
    const next = items.map((item, i) =>
      i === index
        ? { ...item, label, source: item.source === 'inferred' ? 'edited' : item.source }
        : item
    );
    onChange(next);
  };

  const addItem = () => {
    const label = newLabel.trim();
    if (!label) return;
    onChange([
      ...items,
      { label, reason: 'Added by operator', confidence: 1, source: 'user-added' },
    ]);
    setNewLabel('');
  };

  return (
    <section className="space-y-2 rounded border border-border bg-surface-2 p-4">
      <h3 className="text-sm font-semibold text-text">{title}</h3>
      <div className="space-y-2">
        {items.map((item, index) => (
          <div key={`${item.label}-${index}`} className="flex flex-wrap items-center gap-2">
            <input
              value={item.label}
              onChange={(e) => updateLabel(index, e.target.value)}
              className="min-w-[120px] flex-1 rounded border border-border bg-surface px-2 py-1 text-xs text-text"
            />
            <span className="text-[11px] text-text-3">{item.source}</span>
            <button
              type="button"
              className="text-[11px] text-accent"
              onClick={() => toggleSource(index, 'accepted')}
            >
              Accept
            </button>
            <button
              type="button"
              className="text-[11px] text-text-3"
              onClick={() => toggleSource(index, 'rejected')}
            >
              Reject
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Add custom item"
          className="flex-1 rounded border border-border bg-surface px-2 py-1 text-xs text-text"
        />
        <button type="button" className="text-xs text-accent" onClick={addItem}>
          Add
        </button>
      </div>
    </section>
  );
}

export function RedditOpportunityReviewForm({
  scan,
  onChange,
}: {
  scan: RedditOpportunityScan;
  onChange: (next: RedditOpportunityScan) => void;
}) {
  const updateScanConfig = (
    field: keyof RedditOpportunityScan['scanConfig'],
    value: string | number
  ) => {
    onChange({
      ...scan,
      scanConfig: { ...scan.scanConfig, [field]: value },
    });
  };

  return (
    <div className="space-y-4">
      <RecommendationList
        title="Keywords"
        items={scan.recommendations.keywords}
        onChange={(keywords) =>
          onChange({ ...scan, recommendations: { ...scan.recommendations, keywords } })
        }
      />
      <RecommendationList
        title="Subreddits"
        items={scan.recommendations.subreddits}
        onChange={(subreddits) =>
          onChange({ ...scan, recommendations: { ...scan.recommendations, subreddits } })
        }
      />
      <section className="space-y-2 rounded border border-border bg-surface-2 p-4">
        <h3 className="text-sm font-semibold text-text">Scan settings</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-text-2">
            Time window
            <select
              value={scan.scanConfig.timeWindow}
              onChange={(e) => updateScanConfig('timeWindow', e.target.value)}
              className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-xs text-text"
            >
              <option value="7d">7 days</option>
              <option value="30d">30 days</option>
              <option value="90d">90 days</option>
            </select>
          </label>
          <label className="text-xs text-text-2">
            Match mode
            <select
              value={scan.scanConfig.matchMode}
              onChange={(e) => updateScanConfig('matchMode', e.target.value)}
              className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-xs text-text"
            >
              <option value="keyword">Keywords only</option>
              <option value="competitor">Competitors only</option>
              <option value="keyword-and-competitor">Keywords + competitors</option>
            </select>
          </label>
          <label className="text-xs text-text-2">
            Score threshold
            <input
              type="number"
              min={0}
              max={100}
              value={scan.scanConfig.threshold}
              onChange={(e) => updateScanConfig('threshold', Number(e.target.value))}
              className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-xs text-text"
            />
          </label>
          <label className="text-xs text-text-2">
            Result cap
            <input
              type="number"
              min={1}
              max={100}
              value={scan.scanConfig.resultCap}
              onChange={(e) => updateScanConfig('resultCap', Number(e.target.value))}
              className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-xs text-text"
            />
          </label>
        </div>
        <p className="text-[11px] text-text-3">
          Scope: {scan.scanConfig.scope ?? DEFAULT_SCAN_CONFIG.scope}
        </p>
      </section>
    </div>
  );
}
