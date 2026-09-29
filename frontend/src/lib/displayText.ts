const FORMATTING = /<(b|strong|i|em|u|ins|s|strike|del|code|pre|a|tg-emoji|tg-spoiler)(?:\s+(?:[^"'<>]|"[^"]*"|'[^']*')*)?\s*>([\s\S]*?)<\/\1\s*>/gi;
const ENTITIES = /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/gi;
const URL_TOKEN = /(https?:\/\/[^\s<>"']+)/gi;
const decoder = document.createElement("textarea");

export function displayText(value: string | undefined | null): string {
  if (!value) return "";
  let text = value;
  let previous: string;
  do {
    previous = text;
    text = text.replace(FORMATTING, (_, tag: string, content: string) => tag.toLowerCase() === "pre" ? ` ${content} ` : content);
  } while (text !== previous);
  text = text.replace(/<br\s*\/?\s*>/gi, " ");
  return text.split(URL_TOKEN).map((part, index) => {
    if (index % 2) return part;
    // Decode once, after stripping formatting, so author-escaped code stays literal.
    return part.replace(ENTITIES, entity => {
      decoder.innerHTML = entity;
      return decoder.value;
    }).replace(/\u0085/g, " ").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFEFF]/g, "")
      .replace(/\s+/g, " ");
  }).join("").trim();
}

export function displayTitle(title: string | undefined | null, fallbackUrl: string): string {
  return displayText(title) || fallbackUrl;
}
