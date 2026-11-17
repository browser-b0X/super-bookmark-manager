// "Copy page structure" (options, For support): what this page is built of, to fix the readers when a site changes
// its pages. Tag names, test ids, roles and class names only: never text, ids, labels, link or picture addresses, or
// any other attribute value. Any part of a test id or class name that is also part of a link on the page or an @handle
// shown on it, or that holds a long number, is replaced by "*": that is where sites put people's names and posts'
// numbers. What the readers made of the page goes with it, as the names of the fields they found and how many.
// Put in the tab by the right-click menu (activeTab); it reads the page once and keeps nothing.
globalThis.sbmSnapshot = () => {
  // Path words every site uses, which say what kind of page or part it is and name nobody.
  const STRUCTURAL = new Set(["home", "explore", "search", "status", "statuses", "video", "photo", "p", "reel", "reels", "tv",
    "i", "hashtag", "tag", "tags", "settings", "notifications", "messages", "compose", "stories", "direct", "accounts", "about",
    "privacy", "terms", "help", "login", "signup", "foryou", "following", "followers", "live", "music", "discover", "web", "en",
    "www", "intent", "post", "likes", "media", "with_replies", "lists", "communities", "premium", "saved", "tagged", "inbox"]);
  const names = new Set();
  const name = text => {
    const word = String(text).toLowerCase().replace(/^@/, "");
    if (word.length < 2 || STRUCTURAL.has(word)) return;
    names.add(word);
    for (const part of word.split(/[._-]/)) if (part.length >= 3 && !STRUCTURAL.has(part)) names.add(part);
  };
  for (const link of document.querySelectorAll("a[href]")) {
    try { new URL(link.href, location.href).pathname.split("/").forEach(segment => segment && name(decodeURIComponent(segment))); } catch { /* not an address */ }
  }
  location.pathname.split("/").forEach(segment => segment && name(segment));
  for (const handle of (document.body ? document.body.innerText : "").match(/@[\w.]{2,30}/g) || []) name(handle);

  // A name written with its own separators ("jo_li") would fall into pieces too short to tell from words: those are
  // blanked whole first, where they stand as a part of the value.
  const escaped = word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const whole = [...names].filter(word => /[._-]/.test(word)).sort((a, b) => b.length - a.length)
    .map(word => new RegExp("(^|[-_.\\s])" + escaped(word) + "(?=$|[-_.\\s])", "gi"));
  const blanked = value => (/[._-]/.test(value) ? whole.reduce((text, name) => text.replace(name, "$1*"), value) : value);
  const clean = value => blanked(String(value)).split(/([-_.\s]+)/).map(part =>
    /^[-_.\s]*$/.test(part) ? part : /\d{3,}/.test(part) || names.has(part.toLowerCase()) ? "*" : part).join("");
  const describe = element => {
    let line = element.localName;
    const classes = [...element.classList];
    if (classes.length) line += "." + classes.slice(0, 8).map(clean).join(".") + (classes.length > 8 ? `.(+${classes.length - 8})` : "");
    for (const [attribute, label] of [["data-testid", "testid"], ["data-e2e", "e2e"], ["role", "role"]]) {
      const value = element.getAttribute(attribute);
      if (value) line += ` [${label}=${clean(value).slice(0, 80)}]`;
    }
    return line;
  };

  // The extension's own Download buttons (marks.js), for when they don't show: shown, hidden (no address for that post),
  // off screen, or covered by something the page puts over them, named by its structure, position and z-index.
  const markState = host => {
    if (getComputedStyle(host).display === "none") return "hidden: no address";
    const box = host.getBoundingClientRect();
    if (!box.width || !box.height) return "no size";
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return "off screen";
    const top = document.elementFromPoint(x, y);
    if (!top || top === host || host.contains(top)) return "shown";
    const style = getComputedStyle(top);
    return `covered by ${describe(top)} [position:${style.position}, z-index:${style.zIndex}]`;
  };
  const describeAll = element => (element.hasAttribute("data-sbm-mark") ? `sbm-download-button (${markState(element)})` : describe(element));

  const SKIP = new Set(["script", "style", "noscript", "template", "link", "meta"]);
  const LIMIT = 6000;
  const lines = [];
  const walk = (element, depth) => {
    if (lines.length >= LIMIT) return;
    lines.push("  ".repeat(depth) + describeAll(element));
    if (element.localName === "svg") return;
    const children = [...element.children].filter(child => !SKIP.has(child.localName));
    // A feed repeats one shape: the first of a run is shown whole, the rest only counted.
    for (let i = 0; i < children.length;) {
      const shape = describeAll(children[i]);
      let same = 1;
      while (i + same < children.length && describeAll(children[i + same]) === shape) same++;
      walk(children[i], depth + 1);
      if (same > 1 && lines.length < LIMIT) lines.push("  ".repeat(depth + 1) + `(and ${same - 1} more like this)`);
      i += same;
    }
  };
  if (document.body) walk(document.body, 0);

  const page = location.pathname.split("/").map(segment =>
    !segment ? segment : /\d{3,}/.test(segment) ? "#" : STRUCTURAL.has(segment.toLowerCase()) ? segment : "*").join("/");
  const count = selector => document.querySelectorAll(selector).length;
  const fields = post => (post && typeof post === "object" ? Object.keys(post).filter(key => {
    const value = post[key];
    return value !== "" && value !== null && value !== undefined && value !== false && !(Array.isArray(value) && !value.length);
  }).map(key => (Array.isArray(post[key]) ? `${key}(${post[key].length})` : key)).join(" ") : "") || "none";
  let read = null;
  try { read = globalThis.sbmReaders ? globalThis.sbmReaders.readPage() : null; } catch { read = null; }
  const posts = read && Array.isArray(read.posts) ? read.posts : [];
  const marks = [...document.querySelectorAll("[data-sbm-mark]")].map(host => markState(host).replace(/^(covered|hidden).*$/, "$1"));
  const tally = [...new Set(marks)].map(state => `${marks.filter(m => m === state).length} ${state}`);
  return [
    `SuperBookmarks page structure, ${new Date().toISOString().slice(0, 10)}`,
    // Only the three sites are named: the menu works on any page, and another site's name can be somebody's.
    `site: ${/^(www\.|mobile\.|m\.)?(x|twitter|instagram|tiktok)\.com$/i.test(location.hostname) ? location.hostname : "another site"}   page: ${page || "/"}`,
    `counts: article ${count("article")}, main ${count("main")}, video ${count("video")}, img ${count("img")}, time ${count("time")}, ` +
      `test ids ${count("[data-testid]")}, e2e ${count("[data-e2e]")}, dialogs ${count('[role="dialog"]')}`,
    `readers: one post: ${fields(read && read.single)}; posts on the page: ${posts.length}${posts.length ? `, the first has: ${fields(posts[0])}` : ""}`,
    `download buttons: ${marks.length ? `${marks.length} (${tally.join(", ")})` : "none on this page"}`,
    lines.length >= LIMIT ? `(cut at ${LIMIT} lines)` : `${lines.length} lines`,
    "",
    ...lines,
  ].join("\n");
};
