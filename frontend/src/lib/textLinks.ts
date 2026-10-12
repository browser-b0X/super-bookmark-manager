/**
 * Web links written in message text (Telegram, WhatsApp). telegram_refresh.py
 * has the same rules (`links_in_text`, `entity_target`): keep the two identical,
 * or a message's photos and videos are filed under a link the import never stores.
 */

// Stops at white space, ASCII quotes and angle brackets, and at the quote marks,
// CJK brackets and invisible direction marks that messages put around links.
const LINK = /https?:\/\/[^\t\n\x0b\x0c\r \x85\xa0\u1680\u2000-\u200f\u2028-\u202f\u205f-\u2064\u3000\ufeff"'<>\u00ab\u00bb\u201c\u201d\u201e\u201f\u2018\u2019\u2039\u203a\u300c\u300d\u300e\u300f\u3010\u3011\u3008\u3009\u300a\u300b]+/gi;
const TRAILING = /[.,;:!?\u2026\u3002\u3001\uff0c\uff01\uff1f\uff1a\uff1b]+$/;
const BRACKETS: [string, string][] = [["(", ")"], ["[", "]"], ["{", "}"], ["\uff08", "\uff09"]];

/** Links in plain text, with sentence punctuation and unmatched closing brackets dropped. */
export function linksInText(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(LINK)) {
    let url = match[0].replace(TRAILING, "");
    for (const [open, close] of BRACKETS) {
      while (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1);
    }
    found.push(url);
  }
  return found;
}

/**
 * The target of a Telegram "link" or "text_link" part. Telegram also links text
 * typed without http(s):// ("youtube.com/watch?v=…"); like Telegram, it opens on
 * the web, here as https://.
 */
export function entityTarget(part: { type: string; text?: string; href?: string }): string {
  const target = (part.href ?? part.text ?? "").trim();
  return part.type === "link" && target && !/^[a-z][a-z0-9+.-]*:/i.test(target) ? "https://" + target : target;
}
