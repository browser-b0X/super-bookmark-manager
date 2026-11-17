import { useMemo, useState } from "react";
import { Copy, Undo2 } from "lucide-react";
import { useLibrary, type DuplicateMerge } from "../../store/library";
import { findDuplicates, keeperOf, keyLabel } from "../../lib/duplicates";
import { whatItHad } from "../../lib/removedLinks";
import { relTime } from "../../lib/ui";

const shortAddress = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "");

/** The same post saved twice (v0.4.0): links of one post at different addresses (x.com and twitter.com, a share
 *  link, tracking added), merged into one with Undo. */
export default function DuplicatePosts() {
  const posts = useLibrary(s => s.posts);
  const groups = useMemo(() => findDuplicates(posts), [posts]);
  const [open, setOpen] = useState<{ key: string; keep: string } | null>(null);
  const [done, setDone] = useState<{ text: string; merge?: DuplicateMerge } | null>(null);

  const merge = (key: string, keep: string) => {
    const group = groups.find(g => g.key === key);
    if (!group) return;
    const result = useLibrary.getState().mergeDuplicates(keep, group.posts.filter(p => p.id !== keep).map(p => p.id));
    setOpen(null);
    if (result) setDone({ text: `Merged ${group.posts.length} links into “${result.keep.title || shortAddress(result.keep.url)}”.`, merge: result });
  };
  const undo = (merge: DuplicateMerge) => {
    const { restored, skipped } = useLibrary.getState().undoDuplicateMerge(merge);
    setDone({ text: `Put back ${restored} link${restored === 1 ? "" : "s"}${skipped ? `; ${skipped} changed since ${skipped === 1 ? "was" : "were"} left as ${skipped === 1 ? "it is" : "they are"}` : ""}.` });
  };

  return (
    <section className="panel mt-5 p-5" aria-labelledby="duplicates-heading">
      <h3 id="duplicates-heading" className="flex items-center gap-2 text-[.9rem] font-semibold">
        <Copy size={15} className="text-[var(--accent)]" /> The same post, saved twice {groups.length > 0 && <span className="chip">{groups.length}</span>}
      </h3>
      <p className="mt-1.5 text-[.76rem] text-[var(--dim)]">
        Two addresses of one post on X, Instagram, TikTok, Reddit or YouTube (x.com and twitter.com, a share link, tracking added). Merging keeps one link with all their notes, tags and shelves.
      </p>
      {done && (
        <p role="status" className="mt-3 flex flex-wrap items-center gap-2 text-[.76rem]">
          {done.text}
          {done.merge && <button className="btn" style={{ padding: "2px 8px", fontSize: ".72rem" }} onClick={() => undo(done.merge!)}><Undo2 size={12} /> Undo</button>}
        </p>
      )}
      {!groups.length && <p className="mt-3 text-[.76rem] text-[var(--faint)]">No post is saved twice.</p>}
      <ul className="mt-3 space-y-2.5">
        {groups.map(group => {
          const author = group.posts.find(p => p.author)?.author;
          const choosing = open?.key === group.key;
          const keep = choosing ? group.posts.find(p => p.id === open.keep) ?? keeperOf(group.posts) : keeperOf(group.posts);
          const others = group.posts.length - 1;
          return (
            <li key={group.key} className="rounded-xl border border-[var(--border)] p-3 text-[.76rem]" aria-label={keyLabel(group.key)}>
              <div className="flex items-center gap-2">
                <b>{keyLabel(group.key)}</b>
                {author && <span className="text-[var(--faint)]">by {author}</span>}
                <span className="flex-1" />
                {!choosing && <button className="btn btn-primary" style={{ fontSize: ".72rem" }} onClick={() => setOpen({ key: group.key, keep: keeperOf(group.posts).id })}>Merge…</button>}
              </div>
              {choosing ? (
                <fieldset className="mt-2">
                  <legend className="text-[.74rem] text-[var(--dim)]">Keep which link?</legend>
                  {group.posts.map(p => (
                    <label key={p.id} className="mt-1 flex items-start gap-2">
                      <input type="radio" name={`keep-${group.key}`} checked={p.id === keep.id} onChange={() => setOpen({ key: group.key, keep: p.id })} />
                      <span className="min-w-0"><span className="font-medium">{p.title || shortAddress(p.url)}</span>
                        <span className="block truncate text-[.72rem] text-[var(--faint)]">{shortAddress(p.url)} · saved {relTime(p.createdAt)}{p.archiveStatus === "saved" ? " · saved copy" : ""}{whatItHad(p).length ? ` · ${whatItHad(p).join(", ")}` : ""}</span></span>
                    </label>
                  ))}
                  <p className="mt-2 text-[var(--dim)]">
                    The kept link keeps its title, address and saved copy, and takes the tags, shelves and notes of all of them and the oldest saved date.
                    The other {others === 1 ? "link goes, and is" : `${others} links go, and are`} remembered (Removed links), so an import doesn't bring {others === 1 ? "it" : "them"} back.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button className="btn btn-primary" style={{ fontSize: ".72rem" }} onClick={() => merge(group.key, keep.id)}>Merge</button>
                    <button className="btn" style={{ fontSize: ".72rem" }} onClick={() => setOpen(null)}>Cancel</button>
                  </div>
                </fieldset>
              ) : (
                <ul className="mt-1.5 space-y-0.5 text-[.74rem] text-[var(--dim)]">
                  {group.posts.map(p => (
                    <li key={p.id} className="truncate">{p.title || shortAddress(p.url)} · {shortAddress(p.url)} · saved {relTime(p.createdAt)}{whatItHad(p).length ? ` · ${whatItHad(p).join(", ")}` : ""}</li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
