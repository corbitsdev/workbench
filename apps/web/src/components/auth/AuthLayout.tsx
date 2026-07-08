import { type ReactNode } from "react";
import { CorbitsMark } from "../corbits-mark";
import { DitherBackground } from "./DitherBackground";
import { QuoteCard } from "./QuoteCard";

/**
 * Two-column auth shell modeled on the corbits.dev sign-in page: a centered
 * form column on the left and a brand panel with a quote card on the right
 * (hidden on small screens). Pure presentation.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-svh bg-surface lg:grid-cols-2">
      {/* Left — form column */}
      <div className="relative flex flex-col bg-surface">
        <div className="flex items-center gap-2.5 p-6 text-base font-semibold tracking-tight text-text md:p-8">
          <span className="grid h-7 w-7 place-items-center rounded-sm bg-orange text-white">
            <CorbitsMark className="h-[18px] w-[18px]" />
          </span>
          Workbench
        </div>

        <div className="flex flex-1 items-center justify-center px-6 pb-16 md:px-10">
          <div className="w-full max-w-sm">{children}</div>
        </div>
      </div>

      {/* Right — brand panel with the live-dithered ski art and a centered
          quote card. The <img> is the no-JS fallback; the 2D-canvas dither
          (ambient + cursor warp) paints over it. */}
      <div className="relative hidden overflow-hidden bg-charcoal lg:block">
        <img
          src="/images/hero-dither.png"
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full object-cover"
        />
        <DitherBackground className="absolute inset-0 h-full w-full" />
        <QuoteCard />
      </div>
    </div>
  );
}
