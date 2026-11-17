// What the owner saved while SuperBookmarks wasn't running, kept in the extension until the next Save window
// with the app running hands it over (the owner chooses there what to keep). Posts' and pages' text and
// addresses in storage.local; an Instagram post's pictures and video in IndexedDB, 200 MB in all: past that
// the videos of the oldest kept posts are left out first, then their pictures (the posts themselves stay),
// and the next Save window says which. Shared by background.js (Chrome loads it with importScripts).

const QUEUE_LIMIT = 200 * 1024 * 1024;
const QUEUE_DB = "sbm-queue";
const QUEUE_FILES = "files";

function queueDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(QUEUE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(QUEUE_FILES);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function queueFiles(mode, work) {
  const db = await queueDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(QUEUE_FILES, mode);
      const store = transaction.objectStore(QUEUE_FILES);
      const result = work(store);
      transaction.oncomplete = () => resolve(result && "result" in result ? result.result : undefined);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

const putQueueFile = (id, blob) => queueFiles("readwrite", store => { store.put(blob, id); });
const getQueueFile = id => queueFiles("readonly", store => store.get(id));
const deleteQueueFiles = ids => (ids.length ? queueFiles("readwrite", store => { for (const id of ids) store.delete(id); }) : Promise.resolve());

// One change to the queue at a time: two quick saves must not overwrite each other's list.
let queueTurn = Promise.resolve();
function inTurn(work) {
  const run = queueTurn.then(work, work);
  queueTurn = run.catch(() => {});
  return run;
}

async function readQueue() {
  const { queue, queueNotices } = await chrome.storage.local.get(["queue", "queueNotices"]);
  return { items: Array.isArray(queue) ? queue : [], notices: Array.isArray(queueNotices) ? queueNotices : [] };
}

/** Keep one post or page. `item`: { url, title, single (a post or null), files: [{ url, kind, size, type }] };
 *  `blobs`: address -> Blob for the files that came; `limit`: bytes of files kept in all. Returns the queue now. */
const keepForLater = (item, blobs = new Map(), limit = QUEUE_LIMIT) => inTurn(() => keepNow(item, blobs, limit));
async function keepNow(item, blobs, limit) {
  const { items, notices } = await readQueue();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const files = (item.files || []).filter(file => blobs.has(file.url)).map((file, index) => ({
    url: file.url, kind: file.kind, size: blobs.get(file.url).size, type: file.type || "", fileId: `${id}-${index}` }));
  // The same post kept again replaces the older one.
  const older = items.filter(old => old.url === item.url);
  await deleteQueueFiles(older.flatMap(old => (old.files || []).filter(f => !f.dropped).map(f => f.fileId)));
  const kept = items.filter(old => old.url !== item.url);
  // Make room: the oldest videos first, then the oldest pictures; the new post's files last of all.
  const used = () => [...kept, { files }].flatMap(entry => entry.files || []).filter(f => !f.dropped).reduce((sum, f) => sum + f.size, 0);
  for (const kind of ["video", "picture"]) {
    for (const entry of [...kept, { files, title: item.title, single: item.single, keptAt: new Date().toISOString() }]) {
      for (const file of entry.files || []) {
        if (used() <= limit) break;
        if (file.dropped || file.kind !== kind) continue;
        file.dropped = true;
        await deleteQueueFiles([file.fileId]);
        notices.push({ name: queueName(entry), keptAt: entry.keptAt || new Date().toISOString(), kind });
      }
    }
  }
  for (const file of files) if (!file.dropped) await putQueueFile(file.fileId, blobs.get(file.url));
  kept.push({ id, keptAt: new Date().toISOString(), url: item.url, title: String(item.title || "").slice(0, 500), single: item.single || null, files });
  await chrome.storage.local.set({ queue: kept, queueNotices: notices.slice(-20) });
  return kept;
}

/** The owner saved or let go of these in the Save window: they leave the queue (and their notices with them). */
const queueDone = ids => inTurn(() => doneNow(ids));
async function doneNow(ids) {
  const { items } = await readQueue();
  const leaving = items.filter(item => ids.includes(item.id));
  await deleteQueueFiles(leaving.flatMap(item => (item.files || []).filter(f => !f.dropped).map(f => f.fileId)));
  const left = items.filter(item => !ids.includes(item.id));
  await chrome.storage.local.set({ queue: left, queueNotices: left.length ? (await readQueue()).notices : [] });
  return left;
}

/** Files no kept item refers to any more (a write cut short) are removed. */
const sweepQueueFiles = () => inTurn(async () => {
  const { items } = await readQueue();
  const wanted = new Set(items.flatMap(item => (item.files || []).filter(f => !f.dropped).map(f => f.fileId)));
  const keys = await queueFiles("readonly", store => store.getAllKeys());
  await deleteQueueFiles((keys || []).filter(key => !wanted.has(key)));
});

/** "Mara Quinn's post", "the page Ten walks…" */
function queueName(entry) {
  const post = entry.single;
  if (post) {
    const who = post.author || (post.handle ? "@" + post.handle : "");
    return who ? `${who}'s post` : "a post";
  }
  return entry.title ? `the page “${String(entry.title).slice(0, 60)}”` : "a page";
}

const queueBytes = items => items.flatMap(item => item.files || []).filter(f => !f.dropped).reduce((sum, f) => sum + f.size, 0);
