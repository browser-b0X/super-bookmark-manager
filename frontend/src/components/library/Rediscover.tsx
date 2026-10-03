import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Shuffle } from "lucide-react";
import type { SavedPost } from "../../types";
import { rediscover } from "../../lib/rediscover";
import { displayTitle } from "../../lib/displayText";
import { PostPreview } from "./PostViews";

/** When nothing new is waiting, a few older saves come back around at the top of the feed. */
export default function Rediscover({ posts }: { posts: SavedPost[] }) {
  const [salt, setSalt] = useState(0);
  const picks = useMemo(() => rediscover(posts, new Date(), 6, salt), [posts, salt]);
  if (!picks.length) return null;
  return (
    <section className="rediscover rail" aria-labelledby="rediscover-heading">
      <div className="mb-2 flex items-center gap-2">
        <h3 id="rediscover-heading" className="text-[.8rem] font-semibold">Rediscover</h3>
        <span className="text-[.7rem] text-[var(--faint)]">older saves worth another look</span>
        <span className="flex-1" />
        <button className="btn" style={{ padding: "2px 9px", fontSize: ".7rem" }} onClick={() => setSalt(s => s + 1)}
          aria-label="Show different picks"><Shuffle size={12} /> Shuffle</button>
      </div>
      <ul className="rediscover__grid">
        {picks.map(({ post, reason }) => (
          <li key={post.id}>
            <Link to={`/library/item/${post.id}`} className="rediscover__card">
              <div className="rediscover__media"><PostPreview post={post} fill /></div>
              <span className="rediscover__reason">{reason}</span>
              <span className="rediscover__title">{displayTitle(post.title, post.url)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
