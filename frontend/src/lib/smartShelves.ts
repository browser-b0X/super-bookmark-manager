import { parseQuery, queryText, type QueryNode } from "./librarySearch";

/**
 * Smart shelves (v0.4.0): saved searches shown as shelves, built from groups of rules. A shelf stores its search
 * text, so it never loses a part: a search the groups can't show is edited as text instead.
 *   all:  every condition        any:  at least one        none:  not one of them
 */
export type GroupMode = "all" | "any" | "none";
export interface RuleGroup { mode: GroupMode; conditions: QueryNode[] }

const simple = (node: QueryNode) => node.kind === "text" || node.kind === "op";

/** The groups a search is made of, or null when it doesn't fit them (then it is edited as text). */
export function groupsOf(search: string): RuleGroup[] | null {
  const tree = parseQuery(search).tree;
  if (!tree) return [];
  const groups: RuleGroup[] = [];
  let all: RuleGroup | null = null;
  let none: RuleGroup | null = null;
  for (const part of tree.kind === "and" ? tree.items : [tree]) {
    if (simple(part)) {
      if (!all) groups.push(all = { mode: "all", conditions: [] });
      all.conditions.push(part);
      none = null;
    } else if (part.kind === "or" && part.items.every(simple)) {
      groups.push({ mode: "any", conditions: part.items });
      none = null;
    } else if (part.kind === "not" && (simple(part.item) || (part.item.kind === "or" && part.item.items.every(simple)))) {
      const items = part.item.kind === "or" ? part.item.items : [part.item];
      // -a -b is "none of a, b": one group.
      if (none) none.conditions.push(...items); else groups.push(none = { mode: "none", conditions: [...items] });
    } else {
      return null;
    }
  }
  return groups;
}

/** The search text for the groups (empty groups are left out). */
export function searchOf(groups: RuleGroup[]): string {
  const parts: QueryNode[] = [];
  for (const { mode, conditions } of groups) {
    if (!conditions.length) continue;
    const either: QueryNode = conditions.length === 1 ? conditions[0] : { kind: "or", items: conditions };
    if (mode === "all") parts.push(...conditions);
    else if (mode === "any") parts.push(either);
    else parts.push({ kind: "not", item: either });
  }
  return queryText(parts.length === 0 ? null : parts.length === 1 ? parts[0] : { kind: "and", items: parts });
}

/** What a condition can test, as the editor offers it. */
export const CONDITION_KINDS = [
  { kind: "tag", label: "Tag", hint: "bread" },
  { kind: "shelf", label: "Shelf", hint: "food-drink" },
  { kind: "site", label: "Website", hint: "x.com" },
  { kind: "text", label: "Words", hint: "slow bread" },
  { kind: "is", label: "Status", hint: "" },
  { kind: "saved", label: "Saved", hint: "" },
  { kind: "no", label: "Empty", hint: "" },
] as const;
export type ConditionKind = typeof CONDITION_KINDS[number]["kind"];

export const STATUS_CHOICES: [string, string][] = [["new", "New"], ["later", "Later"], ["reading", "Reading"], ["reference", "Kept"],
  ["archived", "Archived"], ["favorite", "Favourite"], ["unfiled", "On no shelf"], ["opened", "Opened"], ["unopened", "Never opened"],
  ["reviewed", "Reviewed"], ["due", "Follow-up due"]];
export const EMPTY_CHOICES: [string, string][] = [["notes", "Notes"], ["tags", "Tags"], ["shelf", "Shelf"], ["description", "Description"],
  ["picture", "Picture"], ["title", "Title"], ["copy", "Saved copy"]];
export const SAVED_CHOICES: [string, string][] = [["7d", "In the last 7 days"], ["30d", "In the last 30 days"], ["1y", "In the last year"]];

/** A condition from the editor's choices; null when the value is empty or not usable. */
export function condition(kind: ConditionKind, value: string): QueryNode | null {
  const v = value.trim().toLowerCase().replace(/^#/, "");
  if (!v) return null;
  if (kind === "text") return { kind: "text", value: v, phrase: /\s/.test(v) };
  if (kind === "saved" && !/^(\d{1,4}[dwmy]|[<>]\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}(\.\.\d{4}-\d{2}-\d{2})?)$/.test(v)) return null;
  if (kind === "tag" || kind === "shelf") return { kind: "op", field: kind, value: v.replace(/\s+/g, "-") };
  return { kind: "op", field: kind, value: v };
}
