// Links in message text: the Telegram and WhatsApp importers, and the server's
// telegram_refresh.py, must find the same link in the same spelling, or a
// message's photos and videos are filed under a link the import never stores.
// Synthetic messages only; the Python side runs with no network.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = await build({
  stdin: {
    contents: `export { parseTelegramExport } from './src/lib/telegram'; export { parseWhatsAppChat } from './src/lib/whatsapp'; export { linksInText } from './src/lib/textLinks';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
  },
  bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent',
});
const lib = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));

const plain = text => ({ type: 'plain', text });
// Messages shaped like the refresh's export (telegram_refresh.export_message).
const messages = [
  { text: 'Статья «https://habr.com/ru/articles/123/»', parts: [plain('Статья «'), { type: 'link', text: 'https://habr.com/ru/articles/123/' }, plain('»')] },
  { text: 'see youtube.com/watch?v=1 now', parts: [plain('see '), { type: 'link', text: 'youtube.com/watch?v=1' }, plain(' now')] },
  { text: 'read this', parts: [{ type: 'text_link', text: 'read this', href: 'https://e.test/a b' }] },
  { text: 'look https://www.google.com/search?q=кошка', parts: [plain('look https://www.google.com/search?q=кошка')] },
  { text: '“https://example.com/guide”…', parts: [plain('“https://example.com/guide”…')] },
  { text: 'https://президент.рф/a/../b.', parts: [plain('https://президент.рф/a/../b.')] },
  { text: 'two (https://a.test/x_(y)) and https://b.test/', parts: [plain('two (https://a.test/x_(y)) and https://b.test/')] },
  { text: 'nothing here', parts: [plain('nothing here')] },
];
const exported = { type: 'saved_messages', messages: messages.map((m, i) => ({
  id: i + 1, type: 'message', text: m.text, date: '2026-10-08T09:00:00+00:00', text_entities: m.parts })) };
const result = lib.parseTelegramExport(JSON.stringify(exported));
assert.deepEqual(result.errors, []);
const firstByMessage = new Map();
for (const post of result.posts) if (!firstByMessage.has(post.sourceMessageId)) firstByMessage.set(post.sourceMessageId, post.url);

const expected = [
  'https://habr.com/ru/articles/123/', 'https://youtube.com/watch?v=1', 'https://e.test/a%20b',
  'https://www.google.com/search?q=%D0%BA%D0%BE%D1%88%D0%BA%D0%B0', 'https://example.com/guide',
  'https://xn--d1abbgf6aiiy.xn--p1ai/b', 'https://a.test/x_(y)', undefined,
];
assert.deepEqual(messages.map((_, i) => firstByMessage.get(String(i + 1))), expected, 'the importer stores these links');

// The server picks the same link, spelled the same way.
const python = process.env.C4_PYTHON || 'python3';
const server = JSON.parse(execFileSync(python, ['-B', '-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(root)})
import telegram_refresh
entries = json.loads(sys.stdin.read())
print(json.dumps([telegram_refresh.first_link(entry) for entry in entries]))
`], { input: JSON.stringify(exported.messages), encoding: 'utf8' }));
assert.deepEqual(server, expected.map(url => url ?? null), 'telegram_refresh.first_link matches the importer');

// WhatsApp uses the same scan for links written in text.
const chat = '12/31/25, 9:41 PM - Sam: Статья «https://habr.com/ru/articles/123/» и “https://example.com/guide”…';
assert.deepEqual(lib.parseWhatsAppChat(chat).posts.map(p => p.url), ['https://habr.com/ru/articles/123/', 'https://example.com/guide']);
console.log('PASS text links: importers and server agree');
