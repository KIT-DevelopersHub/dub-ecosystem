// @dub/ui/icons — Lucide re-export + IconName -> component registry (凍結案 1-1-7).
// The registry is the single resolution point for the closed `IconName` union;
// consumers pass names, never raw Lucide components.
import {
  Home,
  Calendar,
  CheckSquare,
  Bell,
  MessageCircle,
  Users,
  Settings,
  Search,
  Plus,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  AlertTriangle,
  Info,
  X,
  Menu,
  LogOut,
  Shield,
  type LucideIcon,
} from "lucide-react";
import type { IconName } from "./types";

export type { LucideIcon };

export const iconRegistry: Record<IconName, LucideIcon> = {
  home: Home,
  calendar: Calendar,
  "check-square": CheckSquare,
  bell: Bell,
  "message-circle": MessageCircle,
  users: Users,
  settings: Settings,
  search: Search,
  plus: Plus,
  edit: Pencil,
  trash: Trash2,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  "external-link": ExternalLink,
  "alert-triangle": AlertTriangle,
  info: Info,
  x: X,
  menu: Menu,
  "log-out": LogOut,
  shield: Shield,
};

// Direct re-export of Lucide for advanced callers (still tree-shakable).
export * from "lucide-react";
