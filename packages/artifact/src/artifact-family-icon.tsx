import {
  BookOpen,
  FileText,
  GitCompare,
  Globe,
  Mail,
  MessageCircle,
  Presentation,
  Table2,
  type LucideIcon,
} from "lucide-react";
import type { ArtifactPreviewFamily } from "./artifact-preview-family";

const FAMILY_ICONS: Record<ArtifactPreviewFamily, LucideIcon> = {
  document: FileText,
  social: MessageCircle,
  email: Mail,
  research: BookOpen,
  comparison: GitCompare,
  presentation: Presentation,
  data: Table2,
  web: Globe,
};

export function iconForPreviewFamily(
  family: ArtifactPreviewFamily,
): LucideIcon {
  return FAMILY_ICONS[family];
}
