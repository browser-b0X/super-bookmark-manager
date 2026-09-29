"""Optional-provider contracts; isolated SQLite, absent secrets and no real network."""
import contextlib
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import urllib.error

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.verify/github-readiness-20260927/provider-resilience-20260928'
OUT.mkdir(parents=True, exist_ok=True)
FIXTURE = Path(tempfile.mkdtemp(prefix='focused-', dir=OUT))
DB = FIXTURE / 'initial.sqlite'
NAMES = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY',
         'ANTHROPIC_API_KEY', 'MISTRAL_API_KEY', 'LLM_API_KEY', 'LLM_BASE_URL',
         'LLM_MODEL', 'LITELLM_PROXY_KEY', 'LITELLM_PROXY_URL']
for name in NAMES:
    os.environ.pop(name, None)
os.environ.update(SAVED_POSTS_DB_PATH=str(DB), TELEGRAM_API_ID='0', TELEGRAM_API_HASH='')
sys.path.insert(0, str(ROOT))
VIOLATIONS = []


def guard(event, args):
    reason = None
    if event == 'sqlite3.connect' and Path(args[0]).resolve() != DB:
        reason = 'nonfixture database'
    if event == 'open' and not isinstance(args[0], int):
        p = Path(os.fsdecode(args[0])).resolve()
        path, name = p.as_posix().lower(), p.name.lower()
        if name.startswith('.env') or '.session' in name or any(s in path for s in ('/thumb_cache/', '/user data/', '/mozilla/firefox/')):
            reason = 'personal path'
        if p.suffix.lower() in ('.db', '.sqlite') and p != DB:
            reason = 'nonfixture database file'
    if event in ('socket.connect', 'socket.getaddrinfo', 'socket.sendto', 'subprocess.Popen', 'os.kill'):
        reason = 'real network/process'
    if reason:
        VIOLATIONS.append(reason)
        raise AssertionError(reason)


sys.addaudithook(guard)
import app
import categorizer as cat
import storage
import taxonomy

RESULT = {'category_name': 'technology', 'suggested_tags': ['synthetic'], 'reasoning': 'Mock provider classification'}
CONTENT = 'Cooking recipes with ingredients and pasta'


class ProviderError(Exception):
    pass


def fake_sdk():
    module = ModuleType('openai')
    module.OpenAIError = ProviderError
    client = SimpleNamespace(models=SimpleNamespace(list=Mock(return_value=[SimpleNamespace(id='synthetic-model')])),
                             chat=SimpleNamespace(completions=SimpleNamespace(create=Mock(return_value=SimpleNamespace(
                                 choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(RESULT)))])))))
    module.OpenAI = Mock(return_value=client)
    return module, client


def envelope(value):
    return io.BytesIO(json.dumps(value).encode())


class ProviderResilience(unittest.TestCase):
    def setUp(self):
        global DB
        DB = FIXTURE / (self._testMethodName + '.sqlite')
        storage.config.DB_PATH = str(DB)
        storage.init_db()
        self.client = app.app.test_client()
        app.app.logger.disabled = True

    def tearDown(self):
        self.assertEqual(VIOLATIONS, [])
        self.assertTrue(all(name not in os.environ for name in NAMES))

    def request(self, **fields):
        return self.client.post('/api/categorize', json={'content': CONTENT, **fields})

    def fallback(self, response):
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['category_name'], 'food-drink')
        self.assertEqual(response.json['engine'], 'keywords')

    def seed(self, count=3):
        for i in range(count):
            storage.insert_post(990100+i, '2026-09-29', CONTENT, f'https://example.invalid/fixture-{i}', 'other', '{}')
            storage.update_metadata(990100+i, CONTENT, '')

    def test_keywords_only_eight_cases_no_provider_attempt(self):
        cases = json.loads((ROOT/'frontend/tests/fixtures/categorization-cases.json').read_text(encoding='utf-8'))
        with patch.object(cat, 'proxy_available', side_effect=AssertionError('probe')), patch.object(cat, '_get_client', side_effect=AssertionError('SDK')):
            for case in cases:
                r = self.client.post('/api/categorize', json={'content': case['content'], 'keywords_only': True})
                self.assertEqual((r.status_code, r.json['category_name'], r.json['engine']), (200, case['expected'], 'keywords'))

    def test_missing_sdk_and_proxy_without_credentials(self):
        with patch.dict(sys.modules, {'openai': None}), patch.object(cat.urllib.request, 'urlopen', side_effect=urllib.error.URLError(ConnectionRefusedError())) as transport:
            self.fallback(self.request())
            self.assertEqual(transport.call_count, 1)

    def test_proxy_refusal_timeout_transport_auth_failures(self):
        errors = [urllib.error.URLError(ConnectionRefusedError()), TimeoutError(), ConnectionResetError(),
                  urllib.error.HTTPError('http://synthetic.invalid', 401, 'synthetic', {}, None)]
        with patch.dict(sys.modules, {'openai': None}), patch.object(cat, 'proxy_available', return_value=True):
            for error in errors:
                with self.subTest(error=type(error).__name__), patch.object(cat.urllib.request, 'urlopen', side_effect=error) as transport:
                    self.fallback(self.request())
                    self.assertEqual(transport.call_count, 2)

    def test_proxy_malformed_envelopes_and_output(self):
        bodies = [None, {}, {'choices': []}, {'choices': None}, {'choices': [{'message': {'content': None}}]},
                  {'choices': [{'message': {'content': 'not JSON'}}]},
                  {'choices': [{'message': {'content': '{"category_name":null}'}}]}]
        with patch.dict(sys.modules, {'openai': None}), patch.object(cat, 'proxy_available', return_value=True):
            for body in bodies:
                with self.subTest(body=body), patch.object(cat.urllib.request, 'urlopen', side_effect=lambda *a, **k: envelope(body)):
                    self.fallback(self.request())
            for raw in (b'not JSON', b'\xff'):
                with patch.object(cat.urllib.request, 'urlopen', side_effect=lambda *a, **k: io.BytesIO(raw)):
                    self.fallback(self.request())

    def test_proxy_success_preserves_optional_provider(self):
        body = {'choices': [{'message': {'content': json.dumps(RESULT)}}]}
        with patch.object(cat, 'proxy_available', return_value=True), patch.object(cat.urllib.request, 'urlopen', side_effect=lambda *a, **k: envelope(body)), patch.object(cat, '_get_client', side_effect=AssertionError('unneeded SDK')):
            r = self.request()
            self.assertEqual((r.status_code, r.json['engine'], r.json['category_name']), (200, 'proxy', 'technology'))

    def test_bad_proxy_configuration_falls_back(self):
        with patch.dict(sys.modules, {'openai': None}), patch.object(cat, 'PROXY_URL', 'invalid-url'):
            self.fallback(self.request())

    def test_sdk_constructor_configuration_and_auth_errors(self):
        sdk, client = fake_sdk()
        with patch.dict(sys.modules, {'openai': sdk}), patch.object(cat, 'proxy_available', return_value=False):
            for error in (ProviderError('synthetic secret'), ValueError('synthetic config')):
                sdk.OpenAI.side_effect = error
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    self.fallback(self.request())
                self.assertNotIn('synthetic secret', output.getvalue())

    def test_sdk_connection_timeout_auth_retry_logs_redacted(self):
        sdk, client = fake_sdk()
        with patch.dict(sys.modules, {'openai': sdk}), patch.object(cat, 'proxy_available', return_value=False), patch.object(cat.time, 'sleep'):
            for error in (ConnectionRefusedError('SYNTHETIC-KEY'), TimeoutError('SYNTHETIC-KEY'), ProviderError('SYNTHETIC-KEY')):
                client.models.list.reset_mock();client.models.list.side_effect = error
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    self.fallback(self.request())
                self.assertEqual(client.models.list.call_count, 3)
                self.assertNotIn('SYNTHETIC-KEY', output.getvalue())

    def test_direct_provider_success(self):
        sdk, client = fake_sdk()
        with patch.dict(sys.modules, {'openai': sdk}), patch.object(cat, 'proxy_available', return_value=False):
            r = self.request()
            self.assertEqual((r.status_code, r.json['engine'], r.json['category_name']), (200, 'local-llm', 'technology'))

    def test_direct_provider_transport_and_malformed_output(self):
        sdk, client = fake_sdk()
        with patch.dict(sys.modules, {'openai': sdk}), patch.object(cat, 'proxy_available', return_value=False):
            client.chat.completions.create.side_effect = ProviderError('synthetic')
            self.fallback(self.request());client.chat.completions.create.side_effect = None
            for response in (None, SimpleNamespace(choices=[]), SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=None))])):
                client.chat.completions.create.return_value = response
                self.fallback(self.request())

    def test_invalid_requests_stay_400_without_fallback(self):
        with patch.object(cat, 'categorize_content', side_effect=AssertionError('invalid request reached classifier')):
            for body in (None, [], {}, {'content': 2}, {'content': ' '}, {'content': CONTENT, 'keywords_only': 'true'}):
                self.assertEqual(self.client.post('/api/categorize', json=body).status_code, 400)

    def test_internal_and_storage_errors_remain_real_errors(self):
        with patch.object(storage, 'get_categories', side_effect=sqlite3.OperationalError('synthetic storage')):
            self.assertEqual(self.request(keywords_only=True).status_code, 500)
        with patch.object(cat, '_keyword_classify', side_effect=RuntimeError('synthetic programming')):
            self.assertEqual(self.request(keywords_only=True).status_code, 500)
        with patch.object(storage, 'update_classification', side_effect=sqlite3.OperationalError('synthetic write')):
            self.assertEqual(self.request(keywords_only=True, tg_msg_id=990100).status_code, 500)
        with patch.object(cat, '_user_prompt', side_effect=RuntimeError('synthetic programming')), patch.object(cat, 'proxy_available', return_value=True):
            self.assertEqual(self.request().status_code, 500)
        sdk, client = fake_sdk();sdk.OpenAI.side_effect = RuntimeError('synthetic SDK integration bug')
        with patch.dict(sys.modules, {'openai': sdk}), patch.object(cat, 'proxy_available', return_value=False):
            self.assertEqual(self.request().status_code, 500)

    def test_bulk_three_content_posts_written_once_without_provider(self):
        self.seed()
        with patch.dict(sys.modules, {'openai': None}), patch.object(cat.urllib.request, 'urlopen', side_effect=urllib.error.URLError('offline')), patch.object(storage, 'update_classification', wraps=storage.update_classification) as writes:
            r = self.client.post('/api/categorize/unprocessed', json={'untagged': True})
        self.assertEqual((r.status_code, r.json['processed']), (200, 3))
        self.assertEqual([c.args[0] for c in writes.call_args_list], [990100, 990101, 990102])
        with sqlite3.connect(DB) as conn:
            self.assertEqual(conn.execute('SELECT category FROM saved_posts').fetchall(), [('food-drink',)]*3)

    def test_bulk_provider_success_and_disjoint_bare_url(self):
        self.seed(2)
        storage.insert_post(990102, '2026-09-29', '', 'https://example.invalid/recipe', 'other', '{}')
        with patch.object(cat, 'proxy_available', return_value=True), patch.object(cat, 'auto_categorize_post', return_value=RESULT) as provider, patch.object(storage, 'update_classification', wraps=storage.update_classification) as writes:
            r = self.client.post('/api/categorize/unprocessed', json={'untagged': True})
        self.assertEqual((r.status_code, r.json['processed'], provider.call_count, writes.call_count), (200, 3, 2, 3))

    def test_suggestions_unavailable_empty_and_mocked_success_read_only(self):
        self.seed();before = storage.get_categories()
        with patch.object(taxonomy.urllib.request, 'urlopen', side_effect=urllib.error.URLError('offline')):
            r = self.client.get('/api/categories/suggestions')
            self.assertEqual((r.status_code, r.json), (200, {'ok': True, 'suggestions': []}))
        suggestion = {'suggestions': [{'name': 'synthetic-shelf', 'reason': 'synthetic', 'example_count': 3}]}
        with patch.object(taxonomy, '_proxy_json', return_value=suggestion):
            self.assertEqual(self.client.get('/api/categories/suggestions').json['suggestions'], suggestion['suggestions'])
        self.assertEqual(storage.get_categories(), before)

    def test_legacy_fetch_only_mocked_fetch_metadata_real_categorization(self):
        import run
        import metadata_fetcher
        self.seed()
        fetcher = ModuleType('fetcher')
        async def fake_fetch():
            return 3, 3
        def run_immediate_fake(coroutine):
            # The fake has no awaits: avoid Windows asyncio's internal socket pair.
            try:
                coroutine.send(None)
            except StopIteration as finished:
                return finished.value
            raise AssertionError('Synthetic fetch unexpectedly performed asynchronous IO')
        fetcher.fetch_saved_messages = fake_fetch
        with patch.dict(sys.modules, {'fetcher': fetcher, 'openai': None}), patch.object(sys, 'argv', ['run.py', '--fetch-only']), patch.object(run.asyncio, 'run', side_effect=run_immediate_fake), patch.object(metadata_fetcher, 'fetch_missing_metadata', return_value=0), patch.object(cat.urllib.request, 'urlopen', side_effect=urllib.error.URLError('offline')), patch.object(storage, 'update_classification', wraps=storage.update_classification) as writes, patch.object(run, 'do_serve', side_effect=AssertionError('CLI must not serve')):
            run.main()
        self.assertEqual(writes.call_count, 3)


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ProviderResilience))
    (OUT/'focused-results.json').write_text(json.dumps({'tests': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors), 'pass': result.wasSuccessful(), 'fixture': str(FIXTURE), 'providerEnvNamesAbsent': NAMES, 'guardViolations': VIOLATIONS, 'liveProviderRequests': 0}, indent=2))
    raise SystemExit(0 if result.wasSuccessful() else 1)
