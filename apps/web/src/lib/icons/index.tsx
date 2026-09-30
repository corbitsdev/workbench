// Sparkle/Sparkles is banned outright — it read as a generic "AI" cliché.
// A curated re-export, not a full pass-through, so a stray import can't
// reach for an off-list icon or tiptoe around the stroke-width rule.
import { LucideProvider, type LucideIcon, type LucideProps } from "lucide-react";
import type { ReactNode } from "react";

export type Icon = LucideIcon;
export type IconProps = LucideProps;

export {
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown as ArrowsDownUp,
  Bell,
  BookMarked as BookBookmark,
  Bot as Robot,
  Captions,
  Check,
  ChartColumn as ChartBar,
  ChevronDown as CaretDown,
  ChevronLeft as CaretLeft,
  ChevronRight as CaretRight,
  CircleAlert as WarningCircle,
  CircleUser as UserCircle,
  CirclePlay as PlayCircle,
  Clock,
  Compass,
  CornerUpLeft as ArrowBendUpLeft,
  Copy,
  Cpu,
  Diff as GitDiff,
  Ellipsis as DotsThree,
  FileText,
  FileQuestionMark as FileDashed,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Hash,
  Key,
  Layers as Stack,
  LayoutGrid as SquaresFour,
  Link as LinkSimple,
  List as ListBullets,
  LoaderCircle as CircleNotch,
  Lock,
  LogOut as SignOut,
  Maximize2 as ArrowsOut,
  MessageCircle as ChatCircle,
  MessageCircleMore as ChatCircleDots,
  AudioLines,
  Mic as Microphone,
  MicOff as MicrophoneSlash,
  Minimize2 as ArrowsIn,
  Moon,
  MoonStar as MoonStars,
  Palette,
  Paperclip,
  Pencil as PencilSimple,
  Pin as PushPin,
  PinOff as PushPinSlash,
  Plug as Plugs,
  Plus,
  Repeat,
  RotateCw as ArrowClockwise,
  Search as MagnifyingGlass,
  Send as PaperPlaneRight,
  Shield,
  SlidersHorizontal,
  Smile as Smiley,
  Square as Stop,
  SquareArrowOutUpRight as ArrowSquareOut,
  Volume2 as SpeakerHigh,
  Star,
  Sun,
  TriangleAlert as Warning,
  User,
  UserPlus,
  Users,
  Workflow as FlowArrow,
  X,
  Zap as Lightning,
} from "lucide-react";

/** Wraps a subtree so every icon under it defaults to a 2px stroke without
 * repeating it at each call site (the `1em` default size is `tailwind.css`).
 * Mounted once at each app's root (see `apps/web/src/app.tsx`). */
export function BoldIconProvider({ children }: { children: ReactNode }) {
  return <LucideProvider strokeWidth={2}>{children}</LucideProvider>;
}
