import { useNavigate } from 'react-router';
import { LibraryRail } from '../components/layout/LibraryRail';
import { ArtifactGallery } from '../components/layout/ArtifactGallery';
import { useResizableRail } from '../lib/use-resizable-rail';

/**
 * Workbench home: resizable two-pane layout (library rail | handle | gallery),
 * mirroring workbench.html. Phase 1 scaffold — panels render static sample data;
 * Phase 2/3 wire them to real session + artifact providers (CL-985/986/989).
 */
export default function WorkbenchHome() {
  const { width, min, max, dragging, containerRef, handleProps } = useResizableRail();
  const navigate = useNavigate();

  return (
    <div
      ref={containerRef}
      className={`mx-auto grid h-full max-w-[1180px] gap-0 px-2 pb-10 pt-1 ${dragging ? 'select-none' : ''}`}
      style={{ gridTemplateColumns: `${width}px 16px 1fr` }}
    >
      <LibraryRail />

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panels"
        aria-valuenow={width}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        className="group flex cursor-col-resize touch-none items-center justify-center"
        {...handleProps}
      >
        <div
          className={`w-[5px] rounded-full bg-border-strong transition-all duration-300 ease-spring group-hover:bg-orange group-focus:bg-orange ${
            dragging ? 'h-20 bg-orange' : 'h-[46px] group-hover:h-20'
          }`}
        />
      </div>

      <ArtifactGallery onNew={() => navigate('/dashboard')} />
    </div>
  );
}
