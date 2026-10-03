// WhatsApp chat export parsing: Android .txt and iPhone .zip, synthetic data only.
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const out = await build({
  stdin: { contents: `export * from './src/lib/whatsapp'; export { detectImportFormat } from './src/lib/importDetect';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent',
});
const wa = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const check = (name, fn) => fn().then(() => console.log('PASS', name));

const android = [
  '12/31/25, 9:41 PM - Messages and calls are end-to-end encrypted. Only people in this chat can read them.',
  '12/31/25, 9:42 PM - Sam: look at this https://www.tiktok.com/@kitchenlab/video/7412345.',
  'crispy chickpeas!!',
  '12/31/25, 9:43 PM - Sam: <Media omitted>',
  '1/2/26, 7:05 AM - Sam: two links (https://x.com/devnotes/status/1834567) and https://example.invalid/a',
  '1/2/26, 7:06 AM - Sam: again https://x.com/devnotes/status/1834567',
  '1/2/26, 7:07 AM - Sam: ftp://files.example.invalid/x is not a web link',
].join('\n');

await check('Android .txt: senders, continuation lines, punctuation, duplicates', async () => {
  assert.ok(wa.looksLikeWhatsAppChat(android));
  const r = wa.parseWhatsAppChat(android, wa.chatNameFrom('WhatsApp Chat with Sam.txt'));
  assert.deepEqual(r.posts.map(p => p.url), ['https://www.tiktok.com/@kitchenlab/video/7412345', 'https://x.com/devnotes/status/1834567', 'https://example.invalid/a']);
  assert.equal(r.duplicates, 1);
  assert.equal(r.posts[0].source, 'whatsapp');
  assert.equal(r.posts[0].platform, 'tiktok');
  assert.match(r.posts[0].excerpt, /crispy chickpeas/);
  assert.deepEqual(r.posts[0].folderPath, ['WhatsApp', 'Sam']);
  const d = new Date(r.posts[0].createdAt);
  assert.deepEqual([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()], [2025, 12, 31, 21, 42]);
});

const ios = '‎[31/12/2025, 21:41:05] Me: ‎image omitted\r\n[31/12/2025, 21:42:10] Me: https://www.threads.net/@slowtravel/post/C9xyz\r\n[01/01/2026, 08:00:00] Me: Lisbon https://www.facebook.com/lisbonwalks/posts/1\r\n';
function zip(name, text) {
  const data = deflateRawSync(Buffer.from(text)); const nameB = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(text.length, 22); local.writeUInt16LE(nameB.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(text.length, 24); central.writeUInt16LE(nameB.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameB.length + data.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + nameB.length, 12); end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameB, data, central, nameB, end]);
}
await check('iPhone .zip with _chat.txt is detected and day-first dates are read', async () => {
  const file = new Blob([zip('_chat.txt', ios)]);
  const { format, text } = await wa.detectImportFormat(file);
  assert.equal(format, 'whatsapp');
  const r = wa.parseWhatsAppChat(text, wa.chatNameFrom('WhatsApp Chat - Me.zip'));
  assert.deepEqual(r.posts.map(p => p.platform), ['threads', 'facebook']);
  const d = new Date(r.posts[1].createdAt);
  assert.deepEqual([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours()], [2026, 1, 1, 8]);
  assert.deepEqual(r.posts[0].folderPath, ['WhatsApp', 'Me']);
});
await check('plain text detection does not claim other files', async () => {
  assert.equal(wa.looksLikeWhatsAppChat('just some notes\nhttps://example.invalid'), false);
  assert.equal((await wa.detectImportFormat(new Blob(['hello world']))).format, 'unknown');
  assert.equal((await wa.detectImportFormat(new Blob([android]))).format, 'whatsapp');
  assert.equal((await wa.detectImportFormat(new Blob([zip('notes.bin', 'nothing')]))).format, 'unknown');
});
console.log('PASS whatsapp import');
