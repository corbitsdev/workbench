import { useState } from "react";

export interface UrlImageCardProps {
  url: string;
}

export function UrlImageCard({ url }: UrlImageCardProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="flex items-center justify-center rounded-lg bg-surface-2 border border-border px-4 py-3 text-xs text-text-3 max-w-[600px]">
        Image unavailable
      </div>
    );
  }

  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      className="max-w-[600px] max-h-[400px] w-full rounded-lg object-contain"
      onError={() => setFailed(true)}
    />
  );
}
