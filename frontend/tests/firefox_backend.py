import json
import os
from pathlib import Path
import socket
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / ".verify/b2-firefox-places-20260925"
OUT.mkdir(parents=True, exist_ok=True)
tempfile.tempdir = str(OUT)
sys.path.insert(0, str(ROOT))
from firefox_cases import fixture, write_cases, OVERLAP, NEW, UNTITLED
write_cases(OUT / "fixtures")
os.environ["SAVED_POSTS_DB_PATH"] = str(OUT / "unused.sqlite")
import firefox_import as parser
import app as dashboard


class FirefoxTests(unittest.TestCase):
    def setUp(self):
        self.client = dashboard.app.test_client()

    def parse(self, raw):
        return self.client.post('/api/import/firefox', data=raw, content_type='application/octet-stream')

    def test_bookmarks_only(self):
        with patch.object(dashboard.storage, '_connect', side_effect=AssertionError('Library access')), patch.object(socket.socket, 'connect', side_effect=AssertionError('Network')):
            result = self.parse(fixture())
        self.assertEqual(result.status_code, 200)
        data = result.json
        self.assertEqual(data['historyIgnored'], 3)
        self.assertEqual(data['bookmarkRows'], 5)
        entries = data['roots']['bookmarks']['children']
        self.assertEqual([r['url'] for r in entries], [OVERLAP, NEW, UNTITLED, NEW, 'javascript:alert(1)'])
        self.assertEqual(entries[2]['name'], '')
        self.assertNotIn('history-only.invalid', result.get_data(as_text=True))
        self.assertNotIn('History title', result.get_data(as_text=True))

    def test_bad_files_controlled_and_no_library_access(self):
        with patch.object(dashboard.storage, '_connect', side_effect=AssertionError('Library mutation')):
            for name in ['empty', 'not-sqlite', 'truncated', 'missing-bookmarks', 'missing-places', 'schema', 'bad-fk', 'view']:
                with self.subTest(name=name):
                    r = self.parse((OUT / 'fixtures' / name).read_bytes())
                    self.assertEqual(r.status_code, 400)
                    self.assertFalse(r.json['ok'])
                    self.assertNotIn('roots', r.json)
                    self.assertNotIn('history-only.invalid', r.get_data(as_text=True))
        self.assertEqual(list(OUT.glob('saved-posts-firefox-*')), [])

    def test_bounds_origin_and_readonly(self):
        self.assertEqual(self.client.post('/api/import/firefox', data=fixture(), content_type='application/octet-stream', headers={'Origin':'http://evil.invalid'}).status_code,403)
        self.assertEqual(self.client.post('/api/import/firefox', json={}).status_code,415)
        with patch.object(parser, 'MAX_BOOKMARKS', 2):
            self.assertIn('limit', self.parse(fixture()).json['error'])
        with patch.object(parser, 'MAX_BYTES', 100):
            self.assertEqual(self.parse(fixture()).status_code,413)
        original = sqlite3.connect
        seen = []
        def connect(path, **kwargs):
            self.assertTrue(path.endswith('?mode=ro'))
            self.assertEqual(kwargs, {'uri': True, 'timeout': 0})
            conn = original(path, **kwargs)
            with self.assertRaises(sqlite3.OperationalError): conn.execute('CREATE TABLE forbidden(id)')
            seen.append(path)
            return conn
        raw = fixture()
        with patch.object(parser.sqlite3, 'connect', connect):
            self.assertEqual(self.parse(raw).status_code,200)
        self.assertEqual(len(seen),1)

    def test_locked_open_no_retry(self):
        raw = fixture()
        with patch.object(parser.sqlite3, 'connect', side_effect=sqlite3.OperationalError('database is locked')) as call:
            result = self.parse(raw)
        self.assertEqual(result.status_code,400)
        self.assertIn('Close Firefox or make a copy', result.json['error'])
        call.assert_called_once()

    def test_checkpointed_wal_copy(self):
        # Generate a standalone WAL-header copy with no required sidecar contents.
        path = OUT / 'wal-source.sqlite'
        path.write_bytes(fixture())
        with sqlite3.connect(path) as conn:
            conn.execute('PRAGMA journal_mode=WAL')
            conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        raw = path.read_bytes()
        self.assertEqual(raw[18:20], b'\x02\x02')
        self.assertEqual(self.parse(raw).status_code,200)
        self.assertEqual(path.read_bytes(),raw)


if __name__ == '__main__':
    unittest.main(verbosity=2)
