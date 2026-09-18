// Sparkle/Sparkles is banned outright — it read as a generic "AI" cliché.
// A curated re-export, not a full pass-through, so a stray import can't
// reach for an off-list icon or tiptoe around the bold-weight rule.
import { IconContext, type Icon, type IconProps } from "@phosphor-icons/react";
import type { ReactNode } from "react";

export type { Icon, IconProps };

export {
  Archive,
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
  Check,
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
  GitDiff,
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
  Stop,
  SquaresFour,
  User,
  UserCircle,
  UserPlus,
  Users,
  Warning,
  WarningCircle,
  X,
} from "@phosphor-icons/react";

// `IconContext.Provider` replaces Phosphor's whole context value rather
// than merging it, so every library default (`size`) must be restated
// alongside the override — dropping it silently un-sizes bare glyphs.
export const boldIconContextValue = { size: "1em", weight: "bold" } as const;

/** Wraps a subtree so every Phosphor icon under it defaults to bold weight
 * without repeating `weight="bold"` at each call site. Mounted once at each
 * app's root (see `apps/web/src/app.tsx`). */
export function BoldIconProvider({ children }: { children: ReactNode }) {
  return <IconContext.Provider value={boldIconContextValue}>{children}</IconContext.Provider>;
}
