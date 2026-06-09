import { type ReactNode } from 'react';

/**
 * Two-column auth shell: a brand panel on the left (hidden on small screens)
 * and a centered form column on the right. Pure presentation.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      {/* Left — brand panel */}
      <div className="relative hidden flex-col justify-between bg-charcoal p-10 text-text lg:flex">
        <div className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          <div className="h-7 w-7 rounded bg-orange" />
          GTM Workbench
        </div>
        <div className="max-w-sm">
          <blockquote className="text-lg font-medium leading-relaxed text-text-2">
            "Turn sales call transcripts into publishable collateral."
          </blockquote>
          <p className="mt-4 text-sm text-text-3">
            AI-assisted workbench for extracting pain points and generating follow-up content.
          </p>
        </div>
        <p className="text-xs text-text-3">Powered by Interchange</p>
      </div>

      {/* Right — form */}
      <div className="flex flex-col bg-surface">
        <div className="flex flex-1 items-center justify-center p-6 md:p-10">
          <div className="w-full max-w-sm">{children}</div>
        </div>
      </div>
    </div>
  );
}
