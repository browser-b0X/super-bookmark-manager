"""Optional-provider contracts; isolated SQLite, absent secrets and no real network."""
import contextlib
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import ModuleType
import unittest
from unittest.mock import patch
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
import ai_providers
import app
import categorizer as cat
import storage
import taxonomy

RESULT = {'category_name': 'technology', 'suggested_tags': ['synthetic'], 'reasoning': 'Mock provider classification'}
CONTENT = 'Cooking recipes with ingredients and pasta'


AI_FILE = FIXTURE / 'profile' / 'ai.json'
os.environ['SBM_AI_CONFIG_FILE'] = str(AI_FILE)
KEY = 'gsk_SYNTHETIC0000000000000000KEY'


def envelope(value):
    return io.BytesIO(json.dumps(value).encode())


def reply(result=RESULT):
    return {'choices': [{'message': {'content': json.dumps(result)}}], 'usage': {'total_tokens': 42}}


class ProviderResilience(unittest.TestCase):
    def setUp(self):
        global DB
        DB = FIXTURE / (self._testMethodName + '.sqlite')
        storage.config.DB_PATH = str(DB)
        storage.init_db()
        self.client = app.app.test_client()
        app.app.logger.disabled = True
        if AI_FILE.exists():
            AI_FILE.unlink()
        for name in ai_providers.ORDER:
            ai_providers._state[name] = {}

    def configure(self, **providers):
        for name, settings in providers.items():
            ai_providers.update(name, settings)

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
        with patch.object(cat, 'proxy_available', side_effect=AssertionError('probe')), patch.object(ai_providers, 'chat', side_effect=AssertionError('provider')):
            for case in cases:
                r = self.client.post('/api/categorize', json={'content': case['content'], 'keywords_only': True})
                self.assertEqual((r.status_code, r.json['category_name'], r.json['engine']), (200, case['expected'], 'keywords'))

    def test_no_provider_configured_uses_keywords_without_network(self):
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=AssertionError('network')) as transport:
            self.fallback(self.request())
        self.assertEqual(transport.call_count, 0)

    def test_refusal_timeout_transport_auth_failures_fall_back(self):
        self.configure(groq={'key': KEY})
        errors = [urllib.error.URLError(ConnectionRefusedError()), TimeoutError('timed out'), ConnectionResetError(),
                  urllib.error.HTTPError('http://synthetic.invalid', 401, 'synthetic', {}, None),
                  urllib.error.HTTPError('http://synthetic.invalid', 429, 'synthetic', {'Retry-After': '30'}, None)]
        for error in errors:
            ai_providers._state['groq'] = {}
            with self.subTest(error=type(error).__name__), patch.object(ai_providers.urllib.request, 'urlopen', side_effect=error) as transport:
                self.fallback(self.request())
                self.assertEqual(transport.call_count, 1)
                # The failing provider is benched, so the next request does not retry it.
                self.fallback(self.request())
                self.assertEqual(transport.call_count, 1)

    def test_malformed_envelopes_and_output_fall_back(self):
        self.configure(groq={'key': KEY})
        bodies = [None, {}, {'choices': []}, {'choices': None}, {'choices': [{'message': {'content': None}}]},
                  {'choices': [{'message': {'content': 'not JSON'}}]},
                  {'choices': [{'message': {'content': '{"category_name":null}'}}]}]
        for body in bodies:
            ai_providers._state['groq'] = {}
            with self.subTest(body=body), patch.object(ai_providers.urllib.request, 'urlopen', side_effect=lambda *a, **k: envelope(body)):
                self.fallback(self.request())
        for raw in (b'not JSON', b'\xff'):
            ai_providers._state['groq'] = {}
            with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=lambda *a, **k: io.BytesIO(raw)):
                self.fallback(self.request())

    def test_provider_success_reports_engine(self):
        self.configure(groq={'key': KEY})
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=lambda *a, **k: envelope(reply())) as transport:
            r = self.request()
        self.assertEqual((r.status_code, r.json['engine'], r.json['category_name']), (200, 'groq', 'technology'))
        sent = transport.call_args.args[0]
        self.assertEqual(sent.full_url, 'https://api.groq.com/openai/v1/chat/completions')
        self.assertEqual(sent.get_header('Authorization'), 'Bearer ' + KEY)

    def test_failover_to_next_provider_and_bench(self):
        self.configure(gemini={'key': 'AIzaSYNTHETIC000000000000000'}, groq={'key': KEY})
        calls = []
        def transport(request, timeout=None):
            calls.append(request.full_url)
            if 'generativelanguage' in request.full_url:
                raise urllib.error.HTTPError(request.full_url, 429, 'slow down', {}, io.BytesIO(b'{"error":{"message":"Quota exceeded"}}'))
            return envelope(reply())
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=transport):
            first = self.request()
            second = self.request()
        self.assertEqual((first.json['engine'], second.json['engine']), ('groq', 'groq'))
        self.assertEqual(sum('generativelanguage' in c for c in calls), 1)
        state = {p['id']: p for p in self.client.get('/api/ai/providers').json['providers']}
        self.assertEqual(state['gemini']['state'], 'rate_limited')
        self.assertEqual(state['gemini']['detail'], 'Quota exceeded')
        self.assertEqual(state['groq']['today']['requests'], 2)

    def test_reasoning_models_get_a_short_think_and_empty_answers_are_explained(self):
        self.configure(groq={'key': KEY})
        sent = []
        def transport(request, timeout=None):
            if request.full_url.endswith('/models'):
                return envelope({'data': [{'id': 'openai/gpt-oss-20b'}]})
            sent.append(json.loads(request.data))
            return envelope({'choices': [{'message': {'content': '', 'reasoning': 'thinking...'}}]})
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=transport):
            r = self.client.post('/api/ai/providers/groq/test', json={})
        self.assertEqual((sent[0]['reasoning_effort'], sent[0]['include_reasoning']), ('low', False))
        self.assertGreaterEqual(sent[0]['max_tokens'], 400)
        self.assertEqual(r.json['error'], 'bad_response')
        self.assertIn('reasoning', r.json['message'])

    def test_provider_error_text_is_shown_without_the_key(self):
        self.configure(openrouter={'key': 'sk-or-v1-SYNTHETICKEY00000000'})
        body = json.dumps({'error': {'message': 'No endpoints found for sk-or-v1-SYNTHETICKEY00000000'}}).encode()
        def transport(request, timeout=None):
            if request.full_url.endswith('/models'):
                return envelope({'data': []})
            raise urllib.error.HTTPError(request.full_url, 404, 'nope', {}, io.BytesIO(body))
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=transport):
            r = self.client.post('/api/ai/providers/openrouter/test', json={})
        self.assertIn('No endpoints found', r.json['message'])
        self.assertNotIn('SYNTHETICKEY', r.get_data(as_text=True))

    def test_retired_model_walks_to_one_that_answers(self):
        self.configure(nvidia={'key': 'nvapi-SYNTHETIC00000000000000'})
        asked = []
        def transport(request, timeout=None):
            if request.full_url.endswith('/models'):
                return envelope({'data': [{'id': 'nvidia/embed-qa-4'}, {'id': 'acme/fresh-70b-instruct'}]})
            model = json.loads(request.data)['model']
            asked.append(model)
            if model != 'acme/fresh-70b-instruct':
                raise urllib.error.HTTPError(request.full_url, 410, 'Gone', {}, io.BytesIO(b'{"detail":"Gone"}'))
            return envelope(reply())
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=transport):
            r = self.client.post('/api/ai/providers/nvidia/test', json={})
            again = self.client.post('/api/categorize', json={'content': CONTENT})
        self.assertTrue(r.json['ok'], r.json)
        self.assertEqual(r.json['model'], 'acme/fresh-70b-instruct')
        self.assertIn('no longer offered', r.json['note'])
        self.assertLessEqual(len(asked) - 1, ai_providers._MAX_MODEL_TRIES)
        self.assertNotIn('nvidia/embed-qa-4', asked)
        # The replacement is remembered: the next request goes straight to it.
        self.assertEqual(asked[-1], 'acme/fresh-70b-instruct')
        self.assertEqual(again.json['engine'], 'nvidia')

    def test_nemotron_thinking_is_switched_off_and_end_of_life_text_is_shown(self):
        self.configure(nvidia={'key': 'nvapi-SYNTHETIC00000000000000', 'model': 'nvidia/nemotron-3-ultra-550b-a55b'})
        sent = []
        eol = json.dumps({'type': 'about:blank', 'title': 'Gone', 'status': 410,
                          'detail': "The model 'google/gemma-4-31b-it' has reached its end of life."}).encode()
        def transport(request, timeout=None):
            if request.full_url.endswith('/models'):
                return envelope({'data': []})
            body = json.loads(request.data)
            sent.append(body)
            return envelope(reply({'ok': True}))
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=transport):
            r = self.client.post('/api/ai/providers/nvidia/test', json={})
        self.assertTrue(r.json['ok'])
        self.assertEqual(sent[0]['chat_template_kwargs'], {'enable_thinking': False})
        self.assertEqual(ai_providers._http_detail(urllib.error.HTTPError('u', 410, 'Gone', {}, io.BytesIO(eol)), ''),
                         "The model 'google/gemma-4-31b-it' has reached its end of life.")

    def test_retired_everywhere_reports_what_was_tried(self):
        self.configure(nvidia={'key': 'nvapi-SYNTHETIC00000000000000'})
        def transport(request, timeout=None):
            if request.full_url.endswith('/models'):
                return envelope({'data': []})
            raise urllib.error.HTTPError(request.full_url, 410, 'Gone', {}, io.BytesIO(b'{"error":{"message":"Function is not available"}}'))
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=transport):
            r = self.client.post('/api/ai/providers/nvidia/test', json={})
        self.assertFalse(r.json['ok'])
        self.assertIn('Function is not available', r.json['message'])
        self.assertIn('google/gemma-4-31b-it', r.json['message'])

    def test_keys_are_never_returned_logged_or_saved_in_project(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            r = self.client.post('/api/ai/providers/groq', json={'key': KEY})
            with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=urllib.error.HTTPError('u', 401, KEY, {}, None)):
                self.fallback(self.request())
                t = self.client.post('/api/ai/providers/groq/test', json={})
        self.assertEqual(r.status_code, 200)
        for text in (r.get_data(as_text=True), t.get_data(as_text=True), output.getvalue(),
                     self.client.get('/api/ai/providers').get_data(as_text=True)):
            self.assertNotIn(KEY, text)
        self.assertEqual(t.json['error'], 'key_rejected')
        self.assertEqual(next(p for p in r.json['providers'] if p['id'] == 'groq')['keyHint'], '…0KEY')
        self.assertIn(KEY, AI_FILE.read_text(encoding='utf-8'))

    def test_settings_validation(self):
        bad = [('groq', {'key': 'has space in it'}), ('groq', {'key': 'short'}), ('local', {'baseUrl': 'http://example.com/v1'}),
               ('groq', {'baseUrl': 'http://127.0.0.1:1/v1'}), ('nope', {'key': KEY}), ('groq', {'model': 'bad model!'}),
               ('groq', {'surprise': 1})]
        for name, body in bad:
            with self.subTest(name=name, body=body):
                self.assertEqual(self.client.post(f'/api/ai/providers/{name}', json=body).status_code, 400)
        self.assertFalse(AI_FILE.exists())

    def test_local_server_uses_first_listed_model(self):
        self.configure(local={'baseUrl': 'http://127.0.0.1:11434/v1'})
        def transport(request, timeout=None):
            if request.full_url.endswith('/models'):
                return envelope({'data': [{'id': 'synthetic-local'}]})
            self.assertEqual(json.loads(request.data)['model'], 'synthetic-local')
            self.assertIsNone(request.get_header('Authorization'))
            return envelope(reply())
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=transport):
            r = self.request()
        self.assertEqual((r.json['engine'], r.json['category_name']), ('local', 'technology'))

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

    def test_bulk_three_content_posts_written_once_without_provider(self):
        self.seed()
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=urllib.error.URLError('offline')), patch.object(storage, 'update_classification', wraps=storage.update_classification) as writes:
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
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=urllib.error.URLError('offline')):
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
        with patch.dict(sys.modules, {'fetcher': fetcher}), patch.object(sys, 'argv', ['run.py', '--fetch-only']), patch.object(run.asyncio, 'run', side_effect=run_immediate_fake), patch.object(metadata_fetcher, 'fetch_missing_metadata', return_value=0), patch.object(ai_providers.urllib.request, 'urlopen', side_effect=urllib.error.URLError('offline')), patch.object(storage, 'update_classification', wraps=storage.update_classification) as writes, patch.object(run, 'do_serve', side_effect=AssertionError('CLI must not serve')):
            run.main()
        self.assertEqual(writes.call_count, 3)


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ProviderResilience))
    (OUT/'focused-results.json').write_text(json.dumps({'tests': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors), 'pass': result.wasSuccessful(), 'fixture': str(FIXTURE), 'providerEnvNamesAbsent': NAMES, 'guardViolations': VIOLATIONS, 'liveProviderRequests': 0}, indent=2))
    raise SystemExit(0 if result.wasSuccessful() else 1)
