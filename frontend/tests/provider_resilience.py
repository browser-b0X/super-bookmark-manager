"""Optional-provider contracts; isolated SQLite, absent secrets and no real network."""
import contextlib
import io
import json
import time
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
         'LLM_MODEL', 'LITELLM_PROXY_KEY', 'LITELLM_PROXY_URL', 'FREELLMAPI_KEY']
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
            ai_providers._clear(name)
        ai_providers._usage.clear()          # today's counts start at zero in every test
        ai_providers._resolved.clear()       # replacement models found in an earlier test
        ai_providers._details.clear()

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

    def test_a_provider_that_keeps_timing_out_is_benched_longer_each_time(self):
        # A stuck provider used to be tried again every 30 s, holding up a batch each time.
        self.configure(groq={'key': KEY})
        benches = []
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=TimeoutError('timed out')):
            for _ in range(4):
                with self.assertRaises(ai_providers.NoProvider):
                    ai_providers.chat([{'role': 'user', 'content': 'x'}])
                benches.append(round(ai_providers._state['groq']['until'] - time.time()))
                ai_providers._state['groq']['until'] = 0          # the bench ran out; the streak stays
        self.assertEqual([b // 10 * 10 for b in benches], [30, 120, 480, 600])
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=lambda *a, **k: envelope(reply())):
            ai_providers.chat([{'role': 'user', 'content': 'x'}])
        self.assertEqual(ai_providers._streak['groq'], 0, 'one answer resets it')
        # A fractional Retry-After (as some providers send) is honoured, rounded up.
        error = urllib.error.HTTPError('http://synthetic.invalid', 429, 'slow down', {'Retry-After': '7.5'}, None)
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=error):
            with self.assertRaises(ai_providers.NoProvider):
                ai_providers.chat([{'role': 'user', 'content': 'x'}])
        self.assertIn(round(ai_providers._state['groq']['until'] - time.time()), (7, 8))

    def test_freellmapi_is_tried_first_and_the_others_are_the_fallback(self):
        # The owner runs FreeLLMAPI as the main provider; the built-in ones take over when it is down.
        fkey = 'freellmapi-SYNTHETIC00000000000000'
        self.configure(freellmapi={'key': fkey}, gemini={'key': 'AIzaSYNTHETIC000000000000000'}, groq={'key': KEY})
        calls, down = [], {'on': False}
        def transport(request, timeout=None):
            calls.append(request.full_url)
            if request.full_url.startswith('http://127.0.0.1:3001/'):
                sent = json.loads(request.data)
                # Fast models and a short think: a tidy-up is a quick JSON answer.
                self.assertEqual((sent['model'], sent['reasoning_effort']), ('auto:fast', 'low'))
                self.assertEqual(request.get_header('Authorization'), 'Bearer ' + fkey)
                if down['on']:
                    raise urllib.error.URLError(ConnectionRefusedError())
            return envelope(reply())
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=transport):
            # Parallel batches start with different providers among the rest, never ahead of FreeLLMAPI.
            for spread in (0, 1, 2, 3):
                self.assertEqual(ai_providers.chat([{'role': 'user', 'content': 'x'}], spread=spread)[1], 'freellmapi')
            down['on'] = True
            self.assertEqual(ai_providers.chat([{'role': 'user', 'content': 'x'}])[1], 'gemini')
            self.assertEqual(ai_providers.chat([{'role': 'user', 'content': 'x'}], spread=1)[1], 'groq')
        self.assertEqual(calls[4], 'http://127.0.0.1:3001/v1/chat/completions')
        self.assertTrue(calls[5].startswith('https://generativelanguage.googleapis.com/'))
        self.assertEqual(sum(c.startswith('http://127.0.0.1:3001/') for c in calls), 5, 'benched after it failed once')
        providers = ai_providers.status()['providers']
        self.assertEqual([p['id'] for p in providers][:2], ['freellmapi', 'gemini'])
        self.assertEqual(providers[0]['state'], 'unavailable')

    def test_freellmapi_needs_its_key_or_an_address_token_on_this_computer(self):
        status = {p['id']: p for p in ai_providers.status()['providers']}
        self.assertEqual((status['freellmapi']['configured'], status['freellmapi']['baseUrl'], status['freellmapi']['model']),
                         (False, 'http://127.0.0.1:3001/v1', 'auto:fast'))
        # A revocable address token (for clients that can't send headers) is enough on its own.
        self.configure(freellmapi={'baseUrl': 'http://127.0.0.1:3001/v1/t/tok123'})
        status = {p['id']: p for p in ai_providers.status()['providers']}
        self.assertTrue(status['freellmapi']['configured'])
        self.assertEqual(status['freellmapi']['baseUrl'], 'http://127.0.0.1:3001/v1/t/tok123')
        def transport(request, timeout=None):
            self.assertEqual(request.full_url, 'http://127.0.0.1:3001/v1/t/tok123/chat/completions')
            self.assertIsNone(request.get_header('Authorization'))
            return envelope(reply())
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=transport):
            self.assertEqual(ai_providers.chat([{'role': 'user', 'content': 'x'}])[1], 'freellmapi')
        # Only an address on this computer or the home network; never somewhere on the internet.
        for body in ({'baseUrl': 'https://freellmapi.example.com/v1'}, {'baseUrl': 'http://user:pw@127.0.0.1:3001/v1'}):
            with self.subTest(body=body):
                self.assertEqual(self.client.post('/api/ai/providers/freellmapi', json=body).status_code, 400)
        r = self.client.post('/api/ai/providers/freellmapi', json={'key': 'freellmapi-SYNTHETIC00000000000000', 'baseUrl': 'http://192.168.1.20:3001/v1'})
        self.assertEqual(r.status_code, 200)
        saved = json.loads(AI_FILE.read_text(encoding='utf-8'))['providers']['freellmapi']
        self.assertEqual(saved['baseUrl'], 'http://192.168.1.20:3001/v1')
        self.assertNotIn('freellmapi-SYNTHETIC', json.dumps(r.json), 'the key is never sent back')

    def test_an_older_freellmapi_without_auto_fast_falls_back_to_plain_auto(self):
        self.configure(freellmapi={'key': 'freellmapi-SYNTHETIC00000000000000'})
        models = []
        def transport(request, timeout=None):
            if request.full_url.endswith('/models'):
                raise AssertionError('a router picks its own models; none is pinned from its list')
            models.append(json.loads(request.data)['model'])
            if models[-1] == 'auto:fast':
                body = b'{"error":{"message":"Profile \'fast\' not found. Use \'auto\' for the default profile, or call /v1/models for available options."}}'
                raise urllib.error.HTTPError(request.full_url, 400, 'Bad Request', {}, io.BytesIO(body))
            return envelope(reply())
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=transport):
            self.assertEqual(ai_providers.chat([{'role': 'user', 'content': 'x'}])[1], 'freellmapi')
            self.assertEqual(ai_providers.chat([{'role': 'user', 'content': 'y'}])[1], 'freellmapi')
        self.assertEqual(models, ['auto:fast', 'auto', 'auto'], 'asked once, then plain auto for the rest of the session')
        self.assertIn("doesn't offer auto:fast", ai_providers._details['freellmapi'])
        # Saving the provider again (a newer FreeLLMAPI, say) asks for auto:fast again.
        self.configure(freellmapi={'key': 'freellmapi-SYNTHETIC00000000000001'})
        self.assertNotIn('freellmapi', ai_providers._resolved)

    def test_a_slow_freellmapi_is_waited_for_and_benched_only_briefly(self):
        # It fails over between its own providers for up to 45 s; cutting it off at 30 s and benching it
        # for 30 s, 2 min, 8 min stalled a whole run behind one slow answer.
        self.configure(freellmapi={'key': 'freellmapi-SYNTHETIC00000000000000'})
        waits = []
        def transport(request, timeout=None):
            waits.append(timeout)
            raise TimeoutError('timed out')
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=transport):
            for _ in range(3):
                with self.assertRaises(ai_providers.NoProvider):
                    ai_providers.chat([{'role': 'user', 'content': 'x'}], timeout=30)
                self.assertLessEqual(ai_providers._state['freellmapi']['until'] - time.time(), 5.5)
                ai_providers._state['freellmapi']['until'] = 0
        self.assertEqual(waits, [75, 75, 75])
        # A deadline still bounds it.
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=transport):
            with self.assertRaises(ai_providers.NoProvider):
                ai_providers.chat([{'role': 'user', 'content': 'x'}], timeout=30, deadline=time.monotonic() + 20)
        self.assertLessEqual(waits[-1], 20)

    def test_a_freellmapi_answer_cut_off_by_a_thinking_model_is_not_an_outage(self):
        # Owner report: FreeLLMAPI routed a batch to NVIDIA's Nemotron 3 Super, which thinks before it answers
        # unless told otherwise in a field FreeLLMAPI doesn't pass on. The thinking used the whole answer
        # budget, FreeLLMAPI answered 502 "truncated JSON", and the app benched FreeLLMAPI as if it were down.
        self.configure(freellmapi={'key': 'freellmapi-SYNTHETIC00000000000000'}, groq={'key': KEY})
        owner = ('All 1 routed attempt(s) failed with upstream provider errors (format_ignored ×1). This is a provider-side '
                 'failure, not a problem with your request; retry, or check provider status. Attempt trail: '
                 'nvidia/nvidia/nemotron-3-super-120b-a12b key1: format_ignored. Last error: truncated JSON from Nemotron '
                 '(finish_reason=length — raise max_tokens for this json_object request)')
        error = {'message': owner}
        sent = {}
        def transport(request, timeout=None):
            body = json.loads(request.data)
            host = 'freellmapi' if request.full_url.startswith('http://127.0.0.1:3001/') else 'groq'
            sent[host] = body
            if host == 'freellmapi':
                payload = json.dumps({'error': {**error, 'type': 'provider_error', 'code': 'upstream_failed'}}).encode()
                raise urllib.error.HTTPError(request.full_url, 502, 'Bad Gateway', {}, io.BytesIO(payload))
            return envelope(reply())
        messages = [{'role': 'system', 'content': 'Sort links.'}, {'role': 'user', 'content': 'Links: ...'}]
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=transport):
            # Another provider still takes the request in the same call.
            self.assertEqual(ai_providers.chat(messages, max_tokens=1000)[1], 'groq')
            self.assertEqual(ai_providers._state['freellmapi'], {}, 'the router itself is fine: not benched')
            self.assertEqual(ai_providers._streak['freellmapi'], 0)
            # With nothing else to ask, the caller is told the answer was cut off, so it can ask about fewer links.
            self.configure(groq={'enabled': False})
            with self.assertRaises(ai_providers.NoProvider) as raised:
                ai_providers.chat(messages, max_tokens=1000)
            self.assertEqual((raised.exception.code, raised.exception.cut_off), ('bad_response', True))
            self.assertEqual({p['id']: p['state'] for p in ai_providers.status()['providers']}['freellmapi'], 'ready')
            self.assertIn('truncated JSON', ai_providers._details['freellmapi'])
            # Room to think before answering, and Nemotron's own low-effort marker (what its chat template adds
            # when low_effort is set) at the end of the last message. The original messages are left alone.
            self.assertEqual(sent['freellmapi']['max_tokens'], 1000 + ai_providers.PROVIDERS['freellmapi']['thinking_room'])
            self.assertGreaterEqual(ai_providers.PROVIDERS['freellmapi']['thinking_room'], 3000)
            self.assertEqual(sent['freellmapi']['messages'][-1]['content'], 'Links: ...\n\n{reasoning effort: low}')
            self.assertEqual(sent['freellmapi']['messages'][0]['content'], 'Sort links.')
            self.assertEqual(messages[-1]['content'], 'Links: ...')
            self.assertEqual((sent['groq']['max_tokens'], sent['groq']['messages'][-1]['content']), (1000, 'Links: ...'))
            # Real outages still bench it: other failure classes, alone or mixed in with cut-off answers.
            for message in ('All 2 routed attempt(s) failed with upstream provider errors (upstream_error ×2). Last error: 503',
                            'All 3 routed attempt(s) failed with upstream provider errors (timeout ×2, format_ignored ×1). '
                            'Last error: truncated JSON from Nemotron'):
                with self.subTest(message=message):
                    ai_providers._clear('freellmapi')
                    error['message'] = message
                    with self.assertRaises(ai_providers.NoProvider) as raised:
                        ai_providers.chat(messages)
                    self.assertEqual((raised.exception.code, raised.exception.cut_off), ('unavailable', False))
                    self.assertEqual(ai_providers._state['freellmapi']['reason'], 'unavailable')

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

    def test_suggestions_look_at_the_current_library(self):
        # v0.3.0 libraries live in library_items, not in the old Telegram table.
        now = '2026-10-09T00:00:00.000Z'
        posts = [{'id': f'sg-{n}', 'url': f'https://example.invalid/knit/{n}', 'source': 'manual', 'platform': 'web',
                  'domain': 'example.invalid', 'status': 'inbox', 'title': f'Knitting pattern {n}', 'categories': ['other'] if n % 2 else [],
                  'tags': [], 'projectIds': [], 'createdAt': now, 'updatedAt': now, 'metadataStatus': 'none'} for n in range(4)]
        posts.append({**posts[0], 'id': 'sg-filed', 'url': 'https://example.invalid/filed', 'title': 'Already filed', 'categories': ['technology']})
        saved = storage.save_library({'posts': posts, 'deletedUrls': []})
        self.assertEqual(saved.get('rejected', []), [])
        prompts = []
        with patch.object(taxonomy, '_proxy_json', side_effect=lambda system, user, *a, **k: prompts.append(user) or {'suggestions': []}):
            self.assertEqual(self.client.get('/api/categories/suggestions').status_code, 200)
        self.assertEqual(len(prompts), 1, 'the AI was asked about the unfiled library links')
        self.assertIn('Knitting pattern 3', prompts[0])
        self.assertNotIn('Already filed', prompts[0])

    def test_other_websites_cannot_make_the_app_read_or_spend(self):
        with patch.object(taxonomy, '_proxy_json', return_value={'suggestions': []}) as provider:
            for headers in ({'Sec-Fetch-Site': 'cross-site'}, {'Sec-Fetch-Site': 'same-site'}, {'Origin': 'https://evil.example'}):
                self.assertEqual(self.client.get('/api/categories/suggestions', headers=headers).status_code, 403, headers)
            self.assertEqual(provider.call_count, 0)
        self.assertEqual(self.client.get('/api/stats', headers={'Sec-Fetch-Site': 'same-origin'}).status_code, 200)
        self.assertEqual(self.client.get('/api/stats').status_code, 200, 'a request without fetch metadata still works')

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
