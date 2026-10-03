"""AI library suggestions: synthetic provider replies only, no real network or personal data."""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(tempfile.mkdtemp(prefix='ai-library-'))
for name in ('GROQ_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY', 'LLM_BASE_URL'):
    os.environ.pop(name, None)
os.environ.update(SAVED_POSTS_DB_PATH=str(FIXTURE / 'fixture.sqlite'), SBM_AI_CONFIG_FILE=str(FIXTURE / 'ai.json'),
                  TELEGRAM_API_ID='0', TELEGRAM_API_HASH='')
sys.path.insert(0, str(ROOT))

import ai_library  # noqa: E402
import ai_providers  # noqa: E402
import app  # noqa: E402
import storage  # noqa: E402

H = {'Host': '127.0.0.1:5001'}
SHELVES = ['food-drink', 'technology', 'health-fitness', 'other']
ITEMS = [{'id': 'a', 'title': 'chef on Instagram: "6 ingredient lemon cake #baking"', 'text': 'lemon cake recipe', 'url': 'https://www.instagram.com/reel/AAA/'},
         {'id': 'b', 'title': 'FastAPI tutorial', 'text': 'python web framework', 'url': 'https://example.invalid/fastapi'}]


def reply(content):
    return io.BytesIO(json.dumps({'choices': [{'message': {'content': content}}]}).encode())


class AiLibrary(unittest.TestCase):
    def setUp(self):
        storage.init_db()
        self.client = app.app.test_client()
        cfg = FIXTURE / 'ai.json'
        if cfg.exists():
            cfg.unlink()
        for name in ai_providers.ORDER:
            ai_providers._state[name] = {}

    def post(self, **body):
        return self.client.post('/api/ai/suggest', json={'items': ITEMS, 'shelves': SHELVES, 'jobs': ['shelf', 'tags', 'title'], **body}, headers=H)

    def test_without_provider_keywords_suggest_shelves_and_tags_only(self):
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=AssertionError('network')):
            r = self.post()
        self.assertEqual((r.status_code, r.json['engine'], r.json['fallbackReason']), (200, 'keywords', 'no_provider'))
        rows = {row['id']: row for row in r.json['items']}
        self.assertEqual(rows['a']['shelf'], 'food-drink')
        self.assertNotIn('title', rows['a'])

    def test_provider_reply_is_cleaned_and_clamped(self):
        ai_providers.update('groq', {'key': 'gsk_SYNTHETIC_KEY_0000000'})
        content = json.dumps({'items': [
            {'id': 'a', 'shelf': 'Food & Drinks', 'tags': ['#Baking', 'Lemon Cake', 'x' * 60, 'baking'],
             'title': '"' + 'Lemon cake ' * 12 + '"', 'summary': 'Six ingredients.'},
            {'id': 'b', 'shelf': 'brand-new-shelf', 'tags': 'not a list', 'title': 'FastAPI tutorial'},
            {'id': 'zzz', 'shelf': 'technology'},
            {'id': 'a', 'shelf': 'technology'},
        ]})
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=lambda *a, **k: reply(content)):
            r = self.post()
        self.assertEqual(r.json['engine'], 'groq')
        rows = {row['id']: row for row in r.json['items']}
        self.assertEqual(set(rows), {'a', 'b'})
        self.assertEqual(rows['a']['shelf'], 'food-drink')
        self.assertEqual(rows['a']['tags'][:2], ['baking', 'lemon-cake'])
        self.assertTrue(all(len(t) <= 30 for t in rows['a']['tags']))
        self.assertLessEqual(len(rows['a']['title']), 90)
        self.assertFalse(rows['a']['title'].startswith('"'))
        self.assertEqual(rows['b']['shelf'], 'other')
        self.assertNotIn('tags', rows['b'])

    def test_unreadable_reply_falls_back_to_keywords(self):
        ai_providers.update('groq', {'key': 'gsk_SYNTHETIC_KEY_0000000'})
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=lambda *a, **k: reply('no json here')):
            r = self.post()
        self.assertEqual((r.json['engine'], r.json['fallbackReason']), ('keywords', 'bad_response'))

    def test_one_request_per_batch_and_read_only(self):
        ai_providers.update('groq', {'key': 'gsk_SYNTHETIC_KEY_0000000'})
        before = storage.get_library()
        content = json.dumps({'items': [{'id': 'a', 'shelf': 'food-drink'}, {'id': 'b', 'shelf': 'technology'}]})
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=lambda *a, **k: reply(content)) as transport:
            self.post(jobs=['shelf'])
        self.assertEqual(transport.call_count, 1)
        sent = json.loads(transport.call_args.args[0].data)
        self.assertIn('FastAPI tutorial', sent['messages'][1]['content'])
        self.assertEqual(storage.get_library(), before)

    def test_links_the_reply_skipped_are_asked_again(self):
        ai_providers.update('groq', {'key': 'gsk_SYNTHETIC_KEY_0000000'})
        asked = []
        def transport(request, timeout=None):
            content = json.loads(request.data)['messages'][1]['content']
            ids = [i for i in ('a', 'b') if f'"id": "{i}"' in content]
            asked.append(ids)
            # First reply covers only "a" (cut off); the retry covers "b".
            return reply(json.dumps({'items': [{'id': ids[0], 'shelf': 'technology'}]}))
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=transport):
            r = self.post(jobs=['shelf'])
        self.assertEqual(asked, [['a', 'b'], ['b']])
        self.assertEqual(r.json['engine'], 'groq')
        self.assertNotIn('missing', r.json)
        self.assertEqual({row['id'] for row in r.json['items']}, {'a', 'b'})

    def test_busy_providers_report_when_to_retry(self):
        ai_providers.update('groq', {'key': 'gsk_SYNTHETIC_KEY_0000000'})
        import urllib.error
        def transport(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, 429, 'slow', {'Retry-After': '20'}, io.BytesIO(b'{}'))
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=transport):
            r = self.post()
            again = self.post()
        self.assertEqual((r.json['engine'], r.json['fallbackReason']), ('keywords', 'rate_limited'))
        self.assertEqual(set(r.json['missing']), {'a', 'b'})
        self.assertTrue(15 <= r.json['retryIn'] <= 21, r.json['retryIn'])
        # While benched, nothing is sent and the browser is told to wait.
        self.assertEqual((again.json['fallbackReason'], again.json['missing']), ('rate_limited', ['a', 'b']))

    def test_a_slow_provider_cannot_outlast_the_budget(self):
        ai_providers.update('groq', {'key': 'gsk_SYNTHETIC_KEY_0000000'})
        waits = []
        def transport(request, timeout=None):
            waits.append(timeout)
            raise TimeoutError('timed out')
        with patch.object(ai_library, 'BUDGET_SECONDS', 10), \
             patch.object(ai_providers.urllib.request, 'urlopen', side_effect=transport):
            r = self.post()
        self.assertEqual(r.json['fallbackReason'], 'timeout')
        self.assertTrue(waits and all(w <= 10 for w in waits), waits)

    def test_parallel_batches_start_with_different_providers(self):
        ai_providers.update('groq', {'key': 'gsk_SYNTHETIC_KEY_0000000'})
        ai_providers.update('gemini', {'key': 'AIzaSYNTHETIC000000000000000'})
        hosts = []
        def transport(request, timeout=None):
            hosts.append('gemini' if 'generativelanguage' in request.full_url else 'groq')
            return reply(json.dumps({'items': [{'id': 'a', 'shelf': 'food-drink'}, {'id': 'b', 'shelf': 'technology'}]}))
        with patch.object(ai_providers.urllib.request, 'urlopen', side_effect=transport):
            first = self.post(jobs=['shelf'], spread=0)
            second = self.post(jobs=['shelf'], spread=1)
            odd = self.post(jobs=['shelf'], spread='x')
        self.assertEqual((first.json['engine'], second.json['engine']), ('gemini', 'groq'))
        self.assertEqual(odd.json['engine'], 'gemini')

    def test_invalid_requests(self):
        bad = [{'items': []}, {'items': [{}]}, {'items': ITEMS * 6}, {'jobs': []}, {'jobs': ['delete']},
               {'shelves': 'food'}, {'items': [{'id': 7}]}]
        for body in bad:
            with self.subTest(body=body):
                self.assertEqual(self.post(**body).status_code, 400)


if __name__ == '__main__':
    unittest.main(verbosity=2)
