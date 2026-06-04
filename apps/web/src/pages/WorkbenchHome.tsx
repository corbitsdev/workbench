import { AnimatePresence } from 'framer-motion';
import { useState } from 'react';
import { CollateralGenerationPanel } from '../components/CollateralGenerationPanel';
import { LibraryRail } from '../components/layout/LibraryRail';
import { ArtifactGallery } from '../components/layout/ArtifactGallery';
import { useResizableRail } from '@workbench/ui';
import { useMediaQuery } from '../lib/use-media-query';

/**
 * Workbench home. Full-bleed, mobile-responsive layout.
 *
 * Desktop (lg+): resizable two-pane grid (library rail | handle | gallery).
 * The grid is the page scroll container; the rail and handle are sticky at
 * full viewport height while the gallery scrolls with the natural page scroll.
 *
 * Mobile (<lg): single-column gallery with natural scroll; the library opens
 * as a full-screen overlay from a button in the gallery header.
 *
 * The right pane toggles between the artifact gallery and the inline
 * collateral-generation panel — no route change, sidebar and Ada remain visible.
 */
const RAIL_HEIGHT = 'h-full';

export default function WorkbenchHome() {
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const { width, min, max, dragging, containerRef, handleProps } = useResizableRail();
  const [railOpen, setRailOpen] = useState(false);
  const [showGenPanel, setShowGenPanel] = useState(false);

  if (!isDesktop) {
    return (
      <div className="h-full overflow-y-auto px-2 pb-10 pt-1">
        {showGenPanel ? (
          <CollateralGenerationPanel onClose={() => setShowGenPanel(false)} />
        ) : (
          <ArtifactGallery
            onNew={() => setShowGenPanel(true)}
            onOpenLibrary={() => setRailOpen(true)}
          />
        )}
        {railOpen && (
          <div className="fixed inset-0 z-50 bg-page p-2">
            <LibraryRail onClose={() => setRailOpen(false)} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`grid h-full gap-0 overflow-y-auto px-2 pb-10 pt-1 ${dragging ? 'select-none' : ''}`}
      style={{ gridTemplateColumns: `${width}px 16px 1fr` }}
    >
      <div className={`sticky top-0 self-start ${RAIL_HEIGHT}`}>
        <LibraryRail />
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panels"
        aria-valuenow={width}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        className={`group sticky top-0 flex cursor-col-resize touch-none items-center justify-center self-start ${RAIL_HEIGHT}`}
        {...handleProps}
      >
        <div
          className={`w-[5px] rounded-full bg-border-strong transition-all duration-300 ease-spring group-hover:bg-orange group-focus:bg-orange ${
            dragging ? 'h-20 bg-orange' : 'h-[46px] group-hover:h-20'
          }`}
        />
      </div>

      <AnimatePresence mode="wait">
        {showGenPanel ? (
          <CollateralGenerationPanel key="gen-panel" onClose={() => setShowGenPanel(false)} />
        ) : (
          <ArtifactGallery key="gallery" onNew={() => setShowGenPanel(true)} />
        )}
      </AnimatePresence>
    </div>
  );
}
