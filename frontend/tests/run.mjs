// One command for the test suites: the same lists the GitHub check runs on every pull request.
//
//   node frontend/tests/run.mjs                      every group
//   node frontend/tests/run.mjs unit python          only these groups
//   node frontend/tests/run.mjs browser --shard 2/3 --retries 1
//
// unit     The app's logic in Node. Needs `npm ci` in frontend/.
// python   The backend. Needs `pip install -r requirements.txt`.
// browser  The app in a headless Chromium. Needs `npm run build` in frontend/, then
//          `npm install --no-save playwright` and `npx playwright install chromium` there.
//
// Every suite makes up its own links and uses its own throwaway database and folders.
// As a second fence, each one also starts with every data location pointed at a fresh
// temporary folder, so nothing here can read or change a real library, Telegram
// session or key, even on the owner's PC.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const frontend = join(root, 'frontend');
const require = createRequire(import.meta.url);
const windows = process.platform === 'win32';
const python = process.env.PYTHON || process.env.C4_PYTHON || (windows ? 'python' : 'python3');
const OFF = { SBM_SAVED_COPIES: 'off' }; // older suites: never fetch their example links

const GROUPS = {
  unit: ['copy-retry-test', 'follow-up-test', 'library-cache-test', 'library-restore-test', 'library-store-test', 'platform-art-test', 'preview-queue-test', 'related-items',
    'share-page-test', 'text-links-test', 'whatsapp-import'],
  python: ['provider_resilience', 'ai_library_test', 'static_types_test', 'library_api', 'backup_restore_test',
    'archive_backend', 'instagram_backend', 'reddit_backend', 'share_backend', 'tiktok_backend', 'x_post_backend',
    'metadata_backend', 'metadata_gzip', 'telegram_config_test', 'telegram_media_test',
    'telegram_preview_thumbnails_test', 'telegram_refresh_retry_test', 'tls_trust_test', 'firefox_backend',
    'categorization_api',
    // Checks Windows file permissions on the Telegram session, so it only means something on Windows.
    { name: 'telegram_auth_test', only: 'win32' }],
  browser: ['saved-copies-e2e', 'social-posts-e2e', 'bookmark-button-e2e', 'share-e2e', 'archive-viewer-e2e',
    'topnav-e2e', 'follow-up-e2e', 'home-rows-e2e', 'telegram-media-e2e', 'review-fixes-e2e', 'preview-tools-e2e',
    'ai-providers-e2e', 'ai-background-e2e', 'dialogs-e2e', 'platform-art-e2e', 'site-groups-e2e', 'import-lag-e2e', 'backup-e2e',
    { name: 'core-acceptance', env: OFF }, { name: 'library-e2e', env: OFF }, { name: 'save-toast-e2e', env: OFF },
    { name: 'feed-e2e', env: OFF }, { name: 'audit-sync-e2e', env: OFF }, { name: 'import-workflow-e2e', env: OFF },
    { name: 'polish-e2e', env: OFF }, { name: 'quit-e2e', env: OFF }, { name: 'ai-tidy-e2e', env: OFF }],
};

// Arguments: group names, --shard i/n, --retries n.
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const [shardIndex, shardCount] = (option('--shard') || '1/1').split('/').map(Number);
const retries = Number(option('--retries') || 0);
const unknown = args.filter(a => !Object.hasOwn(GROUPS, a));
if (unknown.length || !(shardIndex >= 1 && shardIndex <= shardCount) || !(retries >= 0)) {
  console.error(`Usage: node frontend/tests/run.mjs [${Object.keys(GROUPS).join('|')} ...] [--shard i/n] [--retries n]`);
  if (unknown.length) console.error(`Unknown group: ${unknown.join(', ')}`);
  process.exit(2);
}
const groups = args.length ? args : Object.keys(GROUPS);

// What each group needs, said plainly when it is missing.
const problems = [];
if ((groups.includes('unit') || groups.includes('browser')) && !existsSync(join(frontend, 'node_modules'))) {
  problems.push('Run `npm ci` in frontend/ first.');
}
if (groups.includes('browser')) {
  if (!existsSync(join(frontend, 'dist', 'index.html'))) problems.push('Run `npm run build` in frontend/ first: the browser tests use the built app.');
  try { require.resolve(process.env.C4_PLAYWRIGHT_MODULE || 'playwright'); } catch {
    problems.push('Install the test browser: in frontend/, `npm install --no-save playwright` then `npx playwright install chromium`.');
  }
}
if (groups.includes('python') || groups.includes('browser')) {
  const check = spawnSync(python, ['-c', 'import flask, telethon, truststore'], { encoding: 'utf8' });
  if (check.error) problems.push(`Python was not found as "${python}". Set PYTHON to its path.`);
  else if (check.status !== 0) problems.push('Install the backend packages: `pip install -r requirements.txt`.');
}
if (problems.length) { console.error(problems.map(p => `- ${p}`).join('\n')); process.exit(2); }

const all = groups.flatMap(group => GROUPS[group].map(entry => ({ group, ...(typeof entry === 'string' ? { name: entry } : entry) })));
const suites = all.filter((_, i) => i % shardCount === shardIndex - 1);
const logs = join(root, '.verify', 'test-logs');
mkdirSync(logs, { recursive: true });

function runOnce(suite, attempt) {
  const scratch = mkdtempSync(join(tmpdir(), 'sbm-test-'));
  const fence = {
    SAVED_POSTS_DB_PATH: join(scratch, 'library.sqlite'), SBM_TELEGRAM_SESSION_FILE: join(scratch, 'telegram.session'),
    SBM_AI_CONFIG_FILE: join(scratch, 'ai.json'), SBM_ARCHIVE_DIR: join(scratch, 'archive'), SBM_HELPER_DIR: join(scratch, 'helpers'),
    SUPER_BOOKMARK_MANAGER_DATA_DIR: join(scratch, 'data'),
  };
  const env = { ...process.env, ...fence, C4_PYTHON: python, G5_PYTHON: python, PYTHONDONTWRITEBYTECODE: '1', ...(suite.env || {}) };
  const [command, argv, cwd] = suite.group === 'python'
    ? [python, ['-B', join('frontend', 'tests', `${suite.name}.py`)], root]
    : [process.execPath, [join('tests', `${suite.name}.mjs`)], frontend];
  const log = join(logs, `${suite.name}${attempt ? `.retry${attempt}` : ''}.log`);
  const started = Date.now();
  return new Promise(resolve => {
    const out = createWriteStream(log);
    const child = spawn(command, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(out, { end: false }); child.stderr.pipe(out, { end: false });
    const timer = setTimeout(() => { out.write('\n[run.mjs] stopped after 10 minutes\n'); child.kill('SIGKILL'); }, 10 * 60 * 1000);
    child.on('close', code => {
      clearTimeout(timer);
      out.end(() => {
        try { rmSync(scratch, { recursive: true, force: true }); } catch {}
        resolve({ ok: code === 0, seconds: (Date.now() - started) / 1000, log });
      });
    });
    child.on('error', error => { out.write(String(error)); });
  });
}

const tail = (file, n) => readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-n);
// GitHub shows these lines as annotations on the pull request's check.
const annotate = (title, text) => console.log(`::error title=${title}::${text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
const results = [];
console.log(`Running ${suites.length} suites (${groups.join(', ')}${shardCount > 1 ? `, part ${shardIndex} of ${shardCount}` : ''}). Logs: .verify/test-logs/`);
for (const suite of suites) {
  if (suite.only && suite.only !== process.platform) {
    results.push({ ...suite, status: 'skipped', seconds: 0, note: `runs on ${suite.only === 'win32' ? 'Windows' : suite.only} only` });
    console.log(`SKIP  ${suite.name} (runs on Windows only)`);
    continue;
  }
  let attempt = 0, result = await runOnce(suite, 0);
  while (!result.ok && attempt < retries) { attempt++; console.log(`RETRY ${suite.name}`); result = await runOnce(suite, attempt); }
  const status = result.ok ? (attempt ? 'passed on retry' : 'passed') : 'failed';
  results.push({ ...suite, status, seconds: result.seconds, log: result.log });
  console.log(`${result.ok ? 'PASS ' : 'FAIL '} ${suite.name} (${result.seconds.toFixed(1)}s)${attempt && result.ok ? ' on retry' : ''}`);
  if (!result.ok) {
    console.log(tail(result.log, 30).map(l => `      ${l}`).join('\n'));
    if (process.env.GITHUB_ACTIONS === 'true') annotate(`${suite.name} failed`, tail(result.log, 1)[0]?.slice(0, 300) || 'no output');
  }
}

const failed = results.filter(r => r.status === 'failed');
const flaky = results.filter(r => r.status === 'passed on retry');
const skipped = results.filter(r => r.status === 'skipped');
console.log(`\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed${skipped.length ? `, ${skipped.length} skipped` : ''}`
  + `${flaky.length ? `, ${flaky.length} passed only on a retry (${flaky.map(r => r.name).join(', ')})` : ''}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const icon = { passed: '✅', 'passed on retry': '🟡', failed: '❌', skipped: '⏭️' };
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `### Tests: ${groups.join(', ')}${shardCount > 1 ? ` (part ${shardIndex} of ${shardCount})` : ''}`, '',
    '| Suite | Result | Time |', '| --- | --- | --- |',
    ...results.map(r => `| ${r.name} | ${icon[r.status]} ${r.status}${r.note ? ` (${r.note})` : ''} | ${r.seconds.toFixed(1)}s |`), '', ''].join('\n'));
}
process.exit(failed.length ? 1 : 0);
