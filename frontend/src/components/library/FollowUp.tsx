import { Clock, Repeat } from "lucide-react";
import type { SavedPost } from "../../types";
import { useLibrary } from "../../store/library";
import { FOLLOW_UP_DONE, dayOf, followUpLabel, followUpPresets, followUpState, shortDay } from "../../lib/followUp";

/** "Due today", "Overdue 6 days", "Thu 15 Oct" on a tile; nothing when the link has no follow-up day. */
export function FollowUpBadge({ post, className = "" }: { post: SavedPost; className?: string }) {
  const label = followUpLabel(post);
  const state = followUpState(post);
  if (!label || !state) return null;
  return (
    <span className={`due-badge due-badge--${state} ${className}`} title={`Follow up by ${shortDay(post.followUpAt!)}`}>
      <Clock size={11} aria-hidden="true" /> {label}
    </span>
  );
}

/** The small "use often" mark on a tile. */
export function UseOftenMark({ post, className = "" }: { post: SavedPost; className?: string }) {
  if (!post.useOften) return null;
  return <span className={className} role="img" aria-label="Use often" title="Use often: in the quick row on Home"><Repeat size={13} aria-hidden="true" /></span>;
}

const heading = "mb-1.5 text-[.66rem] font-semibold tracking-[.8px] text-[var(--faint)] uppercase";

/** Link panel: when to follow up, and whether it is in the quick row on Home. */
export function FollowUpSection({ post }: { post: SavedPost }) {
  const updatePost = useLibrary(s => s.updatePost);
  const logActivity = useLibrary(s => s.logActivity);
  const presets = followUpPresets();
  const set = (day: string | undefined) => {
    updatePost(post.id, { followUpAt: day });
    logActivity("organize", day ? `Follow up by ${shortDay(day)}` : "Follow-up removed", post.title);
  };
  const custom = !!post.followUpAt && !presets.some(p => p.day === post.followUpAt);
  const label = followUpLabel(post);
  const opened = post.openCount ?? 0;
  return (
    <>
      <div className="mt-4" role="group" aria-labelledby={`follow-${post.id}`}>
        <div id={`follow-${post.id}`} className={heading}>Follow up</div>
        <div className="flex flex-wrap gap-1.5">
          {presets.map(p => (
            <button key={p.id} className={`chip follow-chip${post.followUpAt === p.day ? " is-on" : ""}`} aria-pressed={post.followUpAt === p.day}
              onClick={() => set(post.followUpAt === p.day ? undefined : p.day)}>
              {p.label}{p.id !== "tomorrow" && post.followUpAt === p.day ? ` · ${shortDay(p.day)}` : ""}
            </button>
          ))}
          <label className={`chip follow-chip follow-chip--date${custom ? " is-on" : ""}`}>
            {custom ? shortDay(post.followUpAt!) : "Pick a date…"}
            <input type="date" aria-label="Pick a follow-up date" min={dayOf(new Date())} value={post.followUpAt ?? ""}
              onChange={e => set(e.target.value || undefined)} />
          </label>
          {post.followUpAt && <button className="chip follow-chip" onClick={() => set(undefined)}>No follow-up</button>}
        </div>
        {post.followUpAt && label && post.status !== "archived"
          ? <div className="mt-2 flex flex-wrap items-center gap-2 text-[.74rem] text-[var(--dim)]">
              <FollowUpBadge post={post} className="due-badge--inline" />
              <button className="btn" onClick={() => { updatePost(post.id, FOLLOW_UP_DONE); logActivity("organize", "Followed up; kept", post.title); }}>
                Done: move to Kept
              </button>
            </div>
          : <p className="mt-1.5 text-[.72rem] text-[var(--faint)]">Shows in Follow up on that day. Done clears the date and moves it to Kept.</p>}
      </div>

      <div className="mt-4">
        <div className={heading}>Use often</div>
        <div className="flex items-center gap-2.5 text-[.8rem]">
          <button type="button" role="switch" aria-checked={!!post.useOften} aria-label="Use often" className="switch"
            onClick={() => updatePost(post.id, { useOften: !post.useOften })} />
          <span>Keep it in the quick row on Home{opened ? <span className="text-[var(--faint)]"> · opened {opened} time{opened === 1 ? "" : "s"}</span> : null}</span>
        </div>
      </div>
    </>
  );
}
