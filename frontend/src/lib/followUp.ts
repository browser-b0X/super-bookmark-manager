import type { SavedPost } from "../types";

/**
 * "Follow up by <day>" and "use often". A follow-up is a calendar day on this
 * computer (YYYY-MM-DD), never an instant, so it does not shift with time zones.
 */

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n: number) => String(n).padStart(2, "0");

/** The local calendar day of a Date, as YYYY-MM-DD. */
export function dayOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A YYYY-MM-DD day as a local Date at noon (safe across daylight-saving changes), or null. */
export function parseDay(value: string | undefined): Date | null {
  const m = value ? DAY.exec(value) : null;
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return dayOf(date) === value ? date : null;
}

/** Whole days from `today` to `day` (negative when overdue). */
export function daysUntil(day: string, today: Date = new Date()): number | null {
  const target = parseDay(day);
  if (!target) return null;
  const start = parseDay(dayOf(today))!;
  return Math.round((target.getTime() - start.getTime()) / 86_400_000);
}

export type FollowUpState = "overdue" | "today" | "soon" | "later";

/** Where a link stands against its follow-up day; null when it has none (or it is archived). */
export function followUpState(post: SavedPost, today: Date = new Date()): FollowUpState | null {
  if (!post.followUpAt || post.status === "archived") return null;
  const days = daysUntil(post.followUpAt, today);
  if (days === null) return null;
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  return days <= 7 ? "soon" : "later";
}

export const isDue = (post: SavedPost, today: Date = new Date()) => {
  const state = followUpState(post, today);
  return state === "overdue" || state === "today";
};

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });

/** "Thu 15 Oct". */
export function shortDay(day: string): string {
  const date = parseDay(day);
  return date ? WEEKDAY.format(date).replace(",", "") : day;
}

/** The badge text: "Overdue 6 days", "Due today", "Tomorrow", "Thu 15 Oct". */
export function followUpLabel(post: SavedPost, today: Date = new Date()): string | null {
  if (!post.followUpAt || post.status === "archived") return null;
  const days = daysUntil(post.followUpAt, today);
  if (days === null) return null;
  if (days < 0) return `Overdue ${-days} day${days === -1 ? "" : "s"}`;
  if (days === 0) return "Due today";
  if (days === 1) return "Tomorrow";
  return shortDay(post.followUpAt);
}

/** The quick choices in the link panel. */
export function followUpPresets(today: Date = new Date()): { id: string; label: string; day: string }[] {
  const plus = (days: number) => { const d = parseDay(dayOf(today))!; d.setDate(d.getDate() + days); return dayOf(d); };
  const month = () => {
    const d = parseDay(dayOf(today))!;
    const wanted = d.getMonth() + 1; d.setMonth(wanted);
    if (d.getMonth() !== wanted % 12) d.setDate(0);   // 31 Jan -> 28/29 Feb, not 3 Mar
    return dayOf(d);
  };
  return [
    { id: "tomorrow", label: "Tomorrow", day: plus(1) },
    { id: "week", label: "In a week", day: plus(7) },
    { id: "month", label: "In a month", day: month() },
  ];
}

/** Follow-up list order: overdue first (oldest first), then by day. */
export function byFollowUp(a: SavedPost, b: SavedPost): number {
  return (a.followUpAt ?? "9999").localeCompare(b.followUpAt ?? "9999");
}

/** What "Done" does: the date goes and the link moves to Kept. */
export const FOLLOW_UP_DONE: Partial<SavedPost> = { followUpAt: undefined, status: "reference" };

/** The quick row on Home: marked links, most opened first, then most recently opened. */
export function useOftenRow(posts: SavedPost[], limit = 8): SavedPost[] {
  return posts.filter(p => p.useOften && p.status !== "archived")
    .sort((a, b) => (b.openCount ?? 0) - (a.openCount ?? 0) || (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? ""))
    .slice(0, limit);
}
