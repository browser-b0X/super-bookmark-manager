import type { SavedPost } from "../types";

/**
 * "Share a shelf": one HTML file that looks like the library and opens in any
 * browser, offline, with nothing uploaded anywhere.
 *
 * Every value is escaped; links are http(s) only; pictures are data: URIs the
 * caller embeds (or none). The page's policy allows no network at all, and
 * its one small script (search and sort) is allowed by its hash only, so the
 * file keeps working, all cards visible, when scripts are blocked.
 */

export interface ShareOptions {
  title: string;
  intro: string;
  /** "Shared 8 Oct 2026". */
  date: Date;
  include: { notes: boolean; status: boolean; favorites: boolean; telegram: boolean };
}

export interface ShareItem {
  post: SavedPost;
  /** A data:image/… URI, already shrunk to 480 px wide, or "" for no picture. */
  picture: string;
}

const STATUS_LABEL: Record<SavedPost["status"], string> = {
  inbox: "Inbox", "to-review": "To review", "in-progress": "In progress", reference: "Reference", archived: "Archived",
};

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function safeLink(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}

const PICTURE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;

function siteOf(post: SavedPost): string {
  try { return post.siteName || new URL(post.url).hostname.replace(/^www\./, ""); } catch { return post.domain || ""; }
}

export function fileName(title: string, date: Date): string {
  const slug = title.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase().slice(0, 60) || "shelf";
  // The local day, the same one the page says it was shared on.
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `${slug}-${day}.html`;
}

const STYLE = `:root{color-scheme:light dark;--bg:#f1f0fa;--card:#fff;--fg:#1c1b29;--dim:#5d5b73;--line:#dddbea;--accent:#6e5bd8;--chip:#efecfb}
@media (prefers-color-scheme:dark){:root{--bg:#1a1a2e;--card:#23213a;--fg:#ecebf5;--dim:#a6a3bd;--line:#34314f;--accent:#9c8cf2;--chip:#2e2b48}}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{max-width:72rem;margin:0 auto;padding:2.2rem 1rem 1rem}h1{margin:0;font-size:1.6rem;line-height:1.2}
.intro{margin:.5rem 0 0;max-width:48rem;color:var(--dim)}.meta{margin:.4rem 0 0;color:var(--dim);font-size:.85rem}
.tools{display:none;gap:.5rem;margin-top:1rem;flex-wrap:wrap}.js .tools{display:flex}
.tools input,.tools select{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.45rem .7rem}
.tools input{flex:1;min-width:12rem}
main{max-width:72rem;margin:0 auto;padding:0 1rem 2rem;display:grid;gap:1.1rem;grid-template-columns:repeat(auto-fill,minmax(15.5rem,1fr))}
.card{display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.card[hidden]{display:none}.pic{display:block;aspect-ratio:4/3;background:var(--chip)}.pic img{display:block;width:100%;height:100%;object-fit:cover}
.body{padding:.8rem .9rem 1rem;display:flex;flex-direction:column;gap:.35rem;min-width:0}
.site{color:var(--dim);font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.title{font-weight:650;line-height:1.3;color:inherit;text-decoration:none;overflow-wrap:anywhere}.title:hover{color:var(--accent)}
.desc{margin:0;color:var(--dim);font-size:.88rem;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.tags{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.2rem}.tag{background:var(--chip);border-radius:999px;padding:.05rem .55rem;font-size:.75rem;color:var(--dim)}
.extra{font-size:.8rem;color:var(--dim);border-top:1px solid var(--line);padding-top:.4rem;margin-top:.2rem;white-space:pre-wrap;overflow-wrap:anywhere}
.extra b{color:var(--fg);font-weight:600}
footer{max-width:72rem;margin:0 auto;padding:1rem 1rem 3rem;color:var(--dim);font-size:.8rem}footer a{color:var(--accent)}
.empty{display:none;color:var(--dim);max-width:72rem;margin:0 auto;padding:0 1rem 2rem}`;

// Search and sort; nothing else. Reads only the page itself.
const SCRIPT = `document.documentElement.classList.add("js");
var q=document.getElementById("q"),s=document.getElementById("s"),m=document.querySelector("main"),e=document.querySelector(".empty");
var cards=Array.prototype.slice.call(m.children);
function run(){var t=q.value.trim().toLowerCase(),n=0;cards.forEach(function(c){var hit=!t||c.getAttribute("data-text").indexOf(t)>=0;c.hidden=!hit;if(hit)n++;});
e.style.display=n?"none":"block";var k=s.value;cards.slice().sort(function(a,b){if(k==="title")return a.getAttribute("data-title").localeCompare(b.getAttribute("data-title"));
var x=a.getAttribute("data-date"),y=b.getAttribute("data-date");return k==="old"?(x<y?-1:x>y?1:0):(x<y?1:x>y?-1:0);}).forEach(function(c){m.appendChild(c);});}
q.addEventListener("input",run);s.addEventListener("change",run);`;

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let binary = "";
  new Uint8Array(digest).forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function card(item: ShareItem, options: ShareOptions): string {
  const { post } = item;
  const link = safeLink(post.url);
  const title = post.title?.trim() || post.url;
  const site = siteOf(post);
  const desc = (post.description || post.excerpt || "").trim().slice(0, 600);
  const extras: string[] = [];
  if (options.include.status) extras.push(`<b>Status:</b> ${escapeHtml(STATUS_LABEL[post.status] ?? post.status)}`);
  if (options.include.favorites && post.favorite) extras.push("<b>Favourite</b>");
  if (options.include.notes && post.userNotes?.trim()) extras.push(`<b>Note:</b> ${escapeHtml(post.userNotes.trim().slice(0, 2000))}`);
  if (options.include.telegram && post.telegramMessage?.text?.trim()) {
    extras.push(`<b>Telegram message:</b> ${escapeHtml(post.telegramMessage.text.trim().slice(0, 2000))}`);
  }
  const searchable = [title, site, desc, ...post.tags].join(" ").toLowerCase();
  const picture = item.picture && PICTURE.test(item.picture)
    ? `<a class="pic" href="${escapeHtml(link)}" rel="noopener noreferrer" tabindex="-1" aria-hidden="true"><img alt="" loading="lazy" src="${item.picture}"></a>` : "";
  return `<article class="card" data-title="${escapeHtml(title.toLowerCase())}" data-date="${escapeHtml(post.createdAt)}" data-text="${escapeHtml(searchable)}">${picture}`
    + `<div class="body"><div class="site">${escapeHtml(site)}</div>`
    + (link ? `<a class="title" href="${escapeHtml(link)}" rel="noopener noreferrer">${escapeHtml(title)}</a>` : `<span class="title">${escapeHtml(title)}</span>`)
    + (desc ? `<p class="desc">${escapeHtml(desc)}</p>` : "")
    + (post.tags.length ? `<div class="tags">${post.tags.slice(0, 12).map(t => `<span class="tag">#${escapeHtml(t)}</span>`).join("")}</div>` : "")
    + (extras.length ? `<div class="extra">${extras.join("<br>")}</div>` : "")
    + `</div></article>`;
}

/** The whole page as a string. Links only: never a saved copy, never the app's own address. */
export async function renderSharePage(items: ShareItem[], options: ShareOptions): Promise<string> {
  const hash = await sha256Base64(SCRIPT);
  const day = options.date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const policy = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'`;
  const title = options.title.trim().slice(0, 200) || "Shared links";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Super Bookmark Manager shared shelf 1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><header><h1>${escapeHtml(title)}</h1>${options.intro.trim() ? `<p class="intro">${escapeHtml(options.intro.trim().slice(0, 1000))}</p>` : ""}
<p class="meta">${items.length} link${items.length === 1 ? "" : "s"} · shared ${escapeHtml(day)}</p>
<div class="tools" role="search"><input id="q" type="search" placeholder="Search these links" aria-label="Search these links">
<select id="s" aria-label="Sort"><option value="new">Newest first</option><option value="old">Oldest first</option><option value="title">Title A–Z</option></select></div></header>
<main>${items.map(item => card(item, options)).join("\n")}</main>
<p class="empty">No links match your search.</p>
<footer>Made with <a href="https://github.com/browser-b0X/super-bookmark-manager" rel="noopener noreferrer">SuperBookmarks</a>. This page is a file: it works offline and sends nothing anywhere.</footer>
<script>${SCRIPT}</script></body></html>
`;
}

/** Shrink a picture to 480 px wide JPEG as a data: URI, in the browser; "" when it can't be read. */
export async function shrinkPicture(blob: Blob, width = 480): Promise<string> {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, width / bitmap.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch {
    return "";
  }
}
