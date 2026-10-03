"""Synthetic-only release boundary tests, no personal runtime access."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
sys.path.insert(0,str(ROOT/'packaging'))
import payload_hygiene
import telegram_config

class Safety(unittest.TestCase):
    def test_forbidden_paths_before_content_access(self):
        names = ['saved_posts.db','x.sqlite','x.sqlite-wal','x.session','x.session-journal',
                 'config.json','credentials.json','secrets.txt','.env','.env.local','backups/a.txt',
                 'exports/a.json','profile/Preferences','User Data/Default/History']
        for name in names:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                p=Path(tmp)/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('synthetic')
                with patch.object(Path,'read_bytes',side_effect=AssertionError('content must not be read')):
                    with self.assertRaises(ValueError): payload_hygiene.scan(Path(tmp))

    def test_installer_rejects_before_receipt_hashing(self):
        import build_installer
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            (root/'SuperBookmarkManager.exe').write_bytes(b'synthetic')
            (root/'credentials.json').write_text('synthetic')
            with patch.object(build_installer,'STANDALONE',root), patch.object(build_installer,'sha256',side_effect=AssertionError('must not hash')):
                with self.assertRaises(ValueError):build_installer.verify_input()

    def test_standalone_rejects_before_bundler(self):
        import build_standalone
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            (root/'frontend/dist').mkdir(parents=True)
            (root/'frontend/dist/.env.local').write_text('synthetic')
            with patch.object(build_standalone,'ROOT',root), patch.object(build_standalone.PyInstaller.__main__,'run') as bundler:
                with self.assertRaises(ValueError):build_standalone.main()
                bundler.assert_not_called()

    def test_archive_member(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'base_library.zip'
            with zipfile.ZipFile(p,'w') as z:z.writestr('secrets.json','synthetic')
            with self.assertRaises(ValueError):payload_hygiene.scan(Path(tmp))

    def test_normal_bundle_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            for name in ['sqlite3.dll','python312.dll','index.html','telegram_config.pyc']:
                (Path(tmp)/name).write_text('synthetic')
            self.assertEqual(payload_hygiene.scan(tmp),4)

    def test_public_config_never_reads_legacy(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);legacy=base/'SavedPostsDashboard';legacy.mkdir()
            p=legacy/'config.json';p.write_text(json.dumps({'telegram':{'api_id':12345,'api_hash':'a'*32}}))
            before=p.read_bytes()
            with patch.dict(os.environ,{'LOCALAPPDATA':tmp,'SUPER_BOOKMARK_MANAGER_DATA_DIR':str(base/'SuperBookmarkManager')},clear=True):
                self.assertEqual(telegram_config.resolve_credentials(),(0,''))
                telegram_config.save_credentials('12345','b'*32)
                self.assertEqual(telegram_config.config_path(),base/'SuperBookmarkManager/config.json')
            self.assertEqual(p.read_bytes(),before)

    def test_legacy_source_resolver_preserved(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{'LOCALAPPDATA':tmp},clear=True):
            self.assertEqual(telegram_config.config_path(),Path(tmp)/'SavedPostsDashboard/config.json')

if __name__=='__main__':unittest.main()
