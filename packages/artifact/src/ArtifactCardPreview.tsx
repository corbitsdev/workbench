import type { ArtifactPreviewFamily } from "./artifact-preview-family";

export type ArtifactCardPreviewProps = {
  family: ArtifactPreviewFamily;
  fill: string;
  excerpt?: string | undefined;
};

function previewFillProps(
  fill: string,
  excerpt?: string | undefined,
): { fill: string; excerpt?: string } {
  if (excerpt === undefined) return { fill };
  return { fill, excerpt };
}

function DocumentPreview({
  fill,
  excerpt,
}: {
  fill: string;
  excerpt?: string;
}) {
  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className={`h-1.5 w-12 rounded-full ${fill}`} />
      <div className="space-y-1.5">
        <div className="h-2 w-full rounded-sm bg-text/10" />
        <div className="h-2 w-[92%] rounded-sm bg-text/8" />
        <div className="h-2 w-[78%] rounded-sm bg-text/8" />
      </div>
      {excerpt ? (
        <p className="mt-auto line-clamp-2 text-[10px] leading-snug text-text-3">
          {excerpt}
        </p>
      ) : null}
    </div>
  );
}

function SocialPreview({ fill, excerpt }: { fill: string; excerpt?: string }) {
  return (
    <div className="flex h-full flex-col p-3">
      <div className="flex items-center gap-2">
        <div className={`h-6 w-6 shrink-0 rounded-full ${fill} opacity-80`} />
        <div className="h-2 flex-1 rounded-sm bg-text/10" />
      </div>
      <p className="mt-2 line-clamp-3 flex-1 text-[10px] leading-snug text-text/80">
        {excerpt ?? "Post preview"}
      </p>
      <div className="mt-2 flex gap-3">
        <div className="h-1.5 w-8 rounded-full bg-text/10" />
        <div className="h-1.5 w-8 rounded-full bg-text/10" />
      </div>
    </div>
  );
}

function EmailPreview({ fill, excerpt }: { fill: string; excerpt?: string }) {
  return (
    <div className="flex h-full flex-col gap-2 p-3 text-left">
      <div className="space-y-1 border-b border-border/60 pb-2">
        <div className="h-1.5 w-10 rounded-sm bg-text/12" />
        <div className={`h-2 w-[70%] rounded-sm ${fill} opacity-30`} />
      </div>
      <p className="line-clamp-4 flex-1 text-[10px] leading-snug text-text-3">
        {excerpt ?? "Email body preview"}
      </p>
    </div>
  );
}

function ResearchPreview({
  fill,
  excerpt,
}: {
  fill: string;
  excerpt?: string;
}) {
  return (
    <div className="flex h-full gap-2 p-3">
      <div className={`w-1 shrink-0 rounded-full ${fill}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="h-2 w-[85%] rounded-sm bg-text/12" />
        <div className="h-1.5 w-full rounded-sm bg-text/8" />
        <div className="h-1.5 w-[90%] rounded-sm bg-text/8" />
        {excerpt ? (
          <p className="mt-1 line-clamp-2 text-[10px] text-text-3">
            {excerpt}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ComparisonPreview({ fill }: { fill: string }) {
  return (
    <div className="grid h-full grid-cols-2 gap-px bg-border/40 p-3">
      <div className="flex flex-col gap-1.5 rounded-sm bg-surface/80 p-2">
        <div className={`h-1.5 w-8 rounded-full ${fill}`} />
        <div className="h-2 w-full rounded-sm bg-text/10" />
        <div className="h-2 w-[80%] rounded-sm bg-text/8" />
      </div>
      <div className="flex flex-col gap-1.5 rounded-sm bg-surface/80 p-2">
        <div className="h-1.5 w-8 rounded-full bg-text/10" />
        <div className="h-2 w-full rounded-sm bg-text/10" />
        <div className="h-2 w-[70%] rounded-sm bg-text/8" />
      </div>
    </div>
  );
}

function PresentationPreview({ fill }: { fill: string }) {
  return (
    <div className="flex h-full items-center justify-center p-3">
      <div
        className={`flex aspect-[16/10] w-full max-w-[140px] flex-col items-center justify-center gap-2 rounded-md border border-border/50 bg-surface/90 shadow-sm ${fill} bg-opacity-10`}
      >
        <div className={`h-2 w-16 rounded-sm ${fill} opacity-50`} />
        <div className="h-1.5 w-20 rounded-sm bg-text/10" />
        <div className="h-1.5 w-14 rounded-sm bg-text/8" />
      </div>
    </div>
  );
}

function DataPreview({ fill }: { fill: string }) {
  return (
    <div className="flex h-full flex-col justify-end gap-1 p-3 pb-4">
      <div className="flex h-14 items-end justify-center gap-1.5">
        {[40, 65, 50, 80, 55].map((h, i) => (
          <div
            key={i}
            className={`w-3 rounded-t-sm ${i === 3 ? fill : "bg-text/15"}`}
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
      <div className="mx-auto h-1 w-16 rounded-full bg-text/10" />
    </div>
  );
}

function WebPreview({ fill, excerpt }: { fill: string; excerpt?: string }) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-sm">
      <div className={`flex h-5 items-center gap-1 px-2 ${fill} opacity-25`}>
        <div className="h-1.5 w-1.5 rounded-full bg-text/30" />
        <div className="h-1.5 w-1.5 rounded-full bg-text/20" />
        <div className="h-1.5 w-1.5 rounded-full bg-text/20" />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2">
        <div className={`h-2 w-2/3 rounded-sm ${fill} opacity-35`} />
        <div className="h-1.5 w-full rounded-sm bg-text/10" />
        {excerpt ? (
          <p className="line-clamp-2 text-[9px] text-text-3">
            {excerpt}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function ArtifactCardPreview({
  family,
  fill,
  excerpt,
}: ArtifactCardPreviewProps) {
  const fillProps = previewFillProps(fill, excerpt);
  switch (family) {
    case "social":
      return <SocialPreview {...fillProps} />;
    case "email":
      return <EmailPreview {...fillProps} />;
    case "research":
      return <ResearchPreview {...fillProps} />;
    case "comparison":
      return <ComparisonPreview fill={fill} />;
    case "presentation":
      return <PresentationPreview fill={fill} />;
    case "data":
      return <DataPreview fill={fill} />;
    case "web":
      return <WebPreview {...fillProps} />;
    case "document":
    default:
      return <DocumentPreview {...fillProps} />;
  }
}
