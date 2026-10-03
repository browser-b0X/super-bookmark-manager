import type { LucideIcon } from "lucide-react";
import {
  AtSign, Camera, Cloud, Facebook, Globe, FileText, Github, Hash, Link2, Linkedin, Music2, Pin, Twitter, Youtube,
} from "lucide-react";
import type { Platform, PostStatus } from "../types";

export const PLATFORM_META: Record<Platform, { label: string; color: string; icon: LucideIcon }> = {
  instagram: { label: "Instagram", color: "#e1306c", icon: Camera },
  x:         { label: "X",         color: "#7ec8ff", icon: Twitter },
  youtube:   { label: "YouTube",   color: "#ff6b6b", icon: Youtube },
  github:    { label: "GitHub",    color: "#a78bfa", icon: Github },
  reddit:    { label: "Reddit",    color: "#ff8f50", icon: Hash },
  tiktok:    { label: "TikTok",    color: "#3ddad7", icon: Music2 },
  facebook:  { label: "Facebook",  color: "#4f8ef7", icon: Facebook },
  threads:   { label: "Threads",   color: "#c9c9d2", icon: AtSign },
  linkedin:  { label: "LinkedIn",  color: "#3b9ce0", icon: Linkedin },
  pinterest: { label: "Pinterest", color: "#e8414b", icon: Pin },
  bluesky:   { label: "Bluesky",   color: "#4aa8ff", icon: Cloud },
  pdf:       { label: "PDF",       color: "#ffb454", icon: FileText },
  web:       { label: "Web",       color: "#8f8f9d", icon: Globe },
  other:     { label: "Other",     color: "#63636f", icon: Link2 },
};

export const STATUS_META: Record<PostStatus, { label: string; color: string }> = {
  "inbox":       { label: "Inbox",       color: "#6c8cff" },
  "to-review":   { label: "To Review",   color: "#ffb454" },
  "in-progress": { label: "In Progress", color: "#3ddad7" },
  "reference":   { label: "Reference",   color: "#4ade80" },
  "archived":    { label: "Archived",    color: "#63636f" },
};

export const STATUS_ORDER: PostStatus[] = ["inbox", "to-review", "in-progress", "reference", "archived"];

export function relTime(iso?: string): string {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (Number.isNaN(s)) return "";
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString();
}
