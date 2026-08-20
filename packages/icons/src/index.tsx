// The one icon surface every app/package imports glyphs through — owner
// ruling (CL-icons-phosphor): Phosphor replaces lucide-react everywhere,
// bold is the only weight, and the Sparkle/Sparkles glyph is banned outright
// (it read as a generic "AI" cliché; every former sparkle spot now carries a
// glyph that means something specific to what it marks). This module is a
// curated re-export, not a full pass-through of `@phosphor-icons/react` —
// only the glyphs the product actually uses are named here, so a stray
// import can't reach for an off-list icon or tiptoe around the weight rule.
//
// Extraction-ready: this is deliberately just re-exports plus one context
// provider, no app-specific logic. If `@corbits/react-ui` grows its own
// icon surface, this file becomes the shim that re-points at it instead of
// every call site changing again.
import { IconContext, type Icon, type IconProps } from "@phosphor-icons/react";
import type { ReactNode } from "react";

export type { Icon, IconProps };

export {
  ArrowBendUpLeft,
  ArrowClockwise,
  ArrowDown,
  ArrowLeft,
  ArrowsDownUp,
  ArrowsIn,
  ArrowsOut,
  ArrowSquareOut,
  ArrowUp,
  Bell,
  BookBookmark,
  CaretDown,
  CaretLeft,
  CaretRight,
  ChartBar,
  ChatCircle,
  ChatCircleDots,
  CircleNotch,
  Clock,
  Compass,
  Copy,
  Cpu,
  DotsThree,
  FileDashed,
  FileText,
  FlowArrow,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Hash,
  Key,
  Lightning,
  LinkSimple,
  ListBullets,
  Lock,
  MagnifyingGlass,
  Microphone,
  MoonStars,
  PaperPlaneRight,
  Paperclip,
  PencilSimple,
  PlayCircle,
  Plus,
  Plugs,
  PuzzlePiece,
  PushPin,
  PushPinSlash,
  Repeat,
  Robot,
  Shield,
  SignOut,
  SlidersHorizontal,
  Smiley,
  Stack,
  Star,
  SquaresFour,
  User,
  UserCircle,
  UserPlus,
  Users,
  Warning,
  WarningCircle,
  X,
} from "@phosphor-icons/react";

/** Wraps a subtree so every Phosphor icon under it defaults to bold weight
 * without repeating `weight="bold"` at each call site. Mounted once at each
 * app's root (see `apps/web/src/app.tsx`). */
export function BoldIconProvider({ children }: { children: ReactNode }) {
  return (
    <IconContext.Provider value={{ weight: "bold" }}>
      {children}
    </IconContext.Provider>
  );
}
