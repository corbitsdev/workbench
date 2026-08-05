import { CorbitsMark } from "@corbits/react-ui";
import type { ReactNode } from "react";

import { DitherBackground } from "./dither-background";
import { QuoteCard } from "./quote-card";

/**
 * Two-column auth shell modeled on the corbits.dev sign-in page: a centered
 * form column on the left and a brand panel with a quote card on the right
 * (hidden on small screens). Pure presentation.
 *
 * This is a local shell rather than react-ui's `blocks/login/auth-layout`
 * because that block hardcodes its own procedural `DitherCanvas` in the brand
 * panel; the signature visual here is an image-driven dither that needs the
 * hero `<img>` painted underneath as the no-JS fallback.
 */
export function AuthLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="auth-shell">
      <main className="auth-form-col">
        <div className="auth-brand">
          <span className="auth-brand-chip">
            <CorbitsMark decorative className="auth-brand-mark" />
          </span>
          Workbench
        </div>

        <div className="auth-form-slot">
          <div className="auth-form">{children}</div>
        </div>
      </main>

      {/* Right — brand panel with the live-dithered ski art and a centered
          quote card. The <img> is the no-JS fallback; the 2D-canvas dither
          (ambient + cursor warp) paints over it. */}
      <div aria-hidden className="auth-panel">
        <img
          src="/images/hero-dither.png"
          alt=""
          className="auth-panel-fallback"
        />
        <DitherBackground className="auth-panel-dither" />
        <QuoteCard />
      </div>
    </div>
  );
}
