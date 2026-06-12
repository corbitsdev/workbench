interface PresentationBodyProps {
  url: string;
}

export default function PresentationBody({ url }: PresentationBodyProps) {
  return (
    <div className="w-full">
      <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
        <iframe
          src={url}
          allow="fullscreen"
          sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
          className="absolute inset-0 w-full h-full border-0 rounded"
          title="Presentation"
        />
      </div>
      <div className="mt-2 text-right">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-text-3 hover:text-text-2 transition-colors"
        >
          Open in Gamma &rarr;
        </a>
      </div>
    </div>
  );
}
