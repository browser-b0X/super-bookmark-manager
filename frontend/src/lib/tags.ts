import type { TagInfo } from "../types";
import type { TagLookup } from "./librarySearch";

/**
 * Nested tags (v0.4.0): a tag can sit under several others (not only one) and have other names. Links carry tags as
 * text; these records say how tags relate, so a search for a tag finds its other names and the tags under it.
 */
export const cleanTagName = (value: string) =>
  Array.from(value.replace(/\p{C}/gu, "").trim().replace(/^#+/, "").toLowerCase().replace(/\s+/g, "-")).slice(0, 100).join("");
/** A name a tag record can hold (SQLite refuses hidden characters and long names). */
const plainTag = (value: string) => !!value.trim() && Array.from(value).length <= 100 && !/\p{C}/u.test(value);
/** A tag record as SQLite takes it, or null when its own name can't be one (its links keep the tag all the same). */
export function fitTag(tag: TagInfo): TagInfo | null {
  return plainTag(tag.name) && tag.name === tag.name.trim().toLowerCase()
    ? { ...tag, parents: tag.parents.filter(plainTag).slice(0, 20), aliases: tag.aliases.filter(plainTag).slice(0, 20) } : null;
}
const unique = (values: string[]) => [...new Set(values)];

/** Finding a tag finds its other names and every tag under it (a tag may sit under several others). */
export function tagLookup(info: TagInfo[]): TagLookup {
  const canonical = new Map<string, string>();            // another name -> its tag
  const children = new Map<string, string[]>();           // tag -> tags right under it
  const aliases = new Map<string, string[]>();
  for (const tag of info) {
    aliases.set(tag.name, tag.aliases);
    for (const alias of tag.aliases) if (!canonical.has(alias)) canonical.set(alias, tag.name);
    for (const parent of tag.parents) children.set(parent, [...(children.get(parent) ?? []), tag.name]);
  }
  return {
    expand(raw: string) {
      const seen = new Set<string>();
      const walk = (name: string) => {
        if (seen.has(name)) return;                         // tags that loop are still finite
        seen.add(name);
        for (const child of children.get(name) ?? []) walk(child);
      };
      walk(canonical.get(raw) ?? raw);
      const names = new Set([raw]);
      for (const name of seen) { names.add(name); for (const alias of aliases.get(name) ?? []) names.add(alias); }
      return [...names];
    },
  };
}

/** The tags under this one (its sub-tags, theirs and so on). */
export function tagsUnder(info: TagInfo[], tag: string): Set<string> {
  const under = new Set(tagLookup(info.map(t => ({ ...t, aliases: [] }))).expand(tag));
  under.delete(tag);
  return under;
}

/** Why this other name can't be added to the tag, or null: a name belongs to one tag only, and a tag of its own
 *  is merged rather than quietly made another tag's name. */
export function aliasProblem(info: TagInfo[], usedOnLinks: string[], tag: string, alias: string): string | null {
  if (!alias) return "Type a name.";
  if (alias === tag) return "That is this tag's own name.";
  const owner = info.find(t => t.name !== tag && (t.name === alias || t.aliases.includes(alias)));
  if (owner && owner.name === alias) return `#${alias} is a tag of its own: merge it into #${tag} instead.`;
  if (owner) return `“${alias}” is already another name of #${owner.name}.`;
  if (usedOnLinks.includes(alias)) return `#${alias} is on links already: merge it into #${tag} instead.`;
  return null;
}

/** Why the tag can't go under this parent, or null (a tag can't sit under itself or one of its sub-tags). */
export function parentProblem(info: TagInfo[], tag: string, parent: string): string | null {
  if (!parent) return "Choose a tag.";
  if (parent === tag) return "A tag can't sit under itself.";
  if (tagsUnder(info, tag).has(parent)) return `#${parent} is under #${tag} already, so #${tag} can't go under it.`;
  return null;
}

export function infoOf(info: TagInfo[], name: string): TagInfo {
  return info.find(t => t.name === name) ?? { id: name, name, parents: [], aliases: [] };
}

/** The tag records a merge of `source` into `target` writes and removes: the target takes the source's name as
 *  another name (so searches for it still work), its other names and parents; tags under the source go under the
 *  target. */
export function mergePlan(info: TagInfo[], source: string, target: string, at: string): { write: TagInfo[]; remove: string[] } {
  const from = infoOf(info, source);
  const into = infoOf(info, target);
  const write: TagInfo[] = [{
    ...into,
    aliases: unique([...into.aliases, source, ...from.aliases]).filter(a => a !== target),
    parents: unique([...into.parents, ...from.parents]).filter(p => p !== target && p !== source),
    updatedAt: at,
  }];
  for (const tag of info) {
    if (tag.name === source || tag.name === target || !tag.parents.includes(source)) continue;
    write.push({ ...tag, parents: unique(tag.parents.map(p => (p === source ? target : p))).filter(p => p !== tag.name), updatedAt: at });
  }
  return { write, remove: info.some(t => t.name === source) ? [source] : [] };
}
