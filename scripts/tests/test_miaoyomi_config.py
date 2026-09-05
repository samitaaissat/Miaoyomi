import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from urllib.parse import unquote, urlsplit

spec = importlib.util.spec_from_file_location('miaoyomi_config', Path(__file__).resolve().parents[1] / 'miaoyomi-config.py')
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


class ConfigurationTest(unittest.TestCase):
    def test_comments_and_quoted_password_match_compose(self):
        for line, expected in (
            ('POSTGRES_PASSWORD=reader-pass # deployment credential', 'reader-pass'),
            ("POSTGRES_PASSWORD='reader-pass\"' # keep the final quote", 'reader-pass"'),
            ("POSTGRES_PASSWORD='reader$literal#pass'", 'reader$literal#pass'),
        ):
            with self.subTest(line=line), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                (root / '.env').write_text(line + '\n')
                config.configure(root)
                result = (root / '.env').read_text()
                self.assertIn(line, result, 'existing comments or values were rewritten')
                dsn = next(line.split('=', 1)[1] for line in result.splitlines() if line.startswith('DATABASE_URL='))
                self.assertEqual(unquote(urlsplit(dsn).password), expected)

    def test_generated_credentials_and_content_are_idempotent(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config.configure(root)
            first = (root / '.env').read_bytes()
            config.configure(root)
            self.assertEqual((root / '.env').read_bytes(), first)
            self.assertEqual((root / '.env').stat().st_mode & 0o777, 0o600)
            for directory in ('manga', 'downloaded-manga', 'novels'):
                self.assertTrue((root / 'data' / directory).is_dir())

    def test_commented_empty_credentials_are_filled(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / '.env').write_text("POSTGRES_PASSWORD='' # generate this\n")
            config.configure(root)
            password = next(line.split('=', 1)[1] for line in (root / '.env').read_text().splitlines() if line.startswith('POSTGRES_PASSWORD='))
            self.assertRegex(password, r'^[a-f0-9]{48}$')


if __name__ == '__main__':
    unittest.main()
