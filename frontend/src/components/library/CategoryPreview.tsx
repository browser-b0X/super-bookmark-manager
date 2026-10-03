import type { CSSProperties } from "react";
import { Bookmark, Briefcase, Clapperboard, Compass, Cpu, HeartPulse, MessagesSquare, Palette, Sparkles, Utensils, type LucideIcon } from "lucide-react";
import type { SavedPost } from "../../types";
import { useLibrary } from "../../store/library";
import SocialCard, { hasWebCardText, platformOf, SOCIAL_PLATFORMS, WebCard } from "./SocialCard";

const ART: Record<string, { label: string; icon: LucideIcon }> = {
  "food-drink": { label: "Food & drink", icon: Utensils },
  technology: { label: "Technology", icon: Cpu },
  "social-media": { label: "Social media", icon: MessagesSquare },
  "health-fitness": { label: "Health & fitness", icon: HeartPulse },
  "arts-culture": { label: "Arts & culture", icon: Palette },
  entertainment: { label: "Entertainment", icon: Clapperboard },
  "business-money": { label: "Business & money", icon: Briefcase },
  "style-beauty": { label: "Style & beauty", icon: Sparkles },
  travel: { label: "Travel", icon: Compass },
};

/** Local category artwork, never presented as an image retrieved from the link. */
export default function CategoryPreview({ post, caption: allowCaption = true }: { post: SavedPost; caption?: boolean }) {
  const categories = useLibrary(s => s.categories);
  // Match the Library card's existing category-color precedence.
  const category = categories.find(c => post.categories.includes(c.name));
  const name = category?.name || post.categories[0] || "uncategorized";
  const art = ART[name];
  const Icon = art?.icon || Bookmark;
  const label = art?.label || (name === "uncategorized" ? "Uncategorized" : name === "other" ? "Other links" : name.replace(/[-_]/g, " "));
  const color = category?.color && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(category.color) ? category.color : "#8f8f9d";
  // Catch Up already prints the caption beside its artwork.
  if (allowCaption && SOCIAL_PLATFORMS.has(platformOf(post))) return <SocialCard post={post} color={color} />;
  if (allowCaption) {
    const card = <WebCard post={post} color={color} />;
    if (hasWebCardText(post)) return card;
  }
  return (
    <div className="category-preview" style={{ "--preview-color": color } as CSSProperties}
      aria-label="No content preview available" title={`${label} category illustration`}>
      <span className="category-preview__motif" aria-hidden="true" />
      <span className="category-preview__icon" aria-hidden="true">
        {post.faviconUrl?.startsWith("/thumb/")
          // The site's own icon makes an image-less link recognisable at a glance.
          ? <img src={post.faviconUrl} alt="" width={40} height={40} className="category-preview__site" />
          : <Icon size={36} strokeWidth={1.4} />}
      </span>
      <span className="category-preview__label">{post.faviconUrl?.startsWith("/thumb/") ? (post.siteName || post.domain) : label}</span>
    </div>
  );
}