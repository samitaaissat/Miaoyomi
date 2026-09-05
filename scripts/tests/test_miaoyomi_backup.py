import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('miaoyomi_backup', Path(__file__).resolve().parents[1] / 'miaoyomi-backup.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupPreflightTest(unittest.TestCase):
    def test_empty_filesystem_housekeeping_is_not_a_restore_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            housekeeping = root / 'lost+found'
            housekeeping.mkdir()
            def probe():
                return subprocess.check_output(['find', *backup.empty_probe_arguments(str(root))]).strip()
            self.assertEqual(probe(), b'')
            (housekeeping / 'recovered-inode').write_text('must not overwrite this')
            self.assertTrue(probe())
            (housekeeping / 'recovered-inode').unlink()
            (root / 'chapter.cbz').write_text('existing book')
            self.assertTrue(probe())
            (root / 'chapter.cbz').unlink()
            housekeeping.rmdir()
            housekeeping.write_text('a file with the same name is not housekeeping')
            self.assertTrue(probe())

    def fixture(self, root):
        saved = root / 'backup'
        saved.mkdir()
        names = ['database.dump', 'configuration.env', *(f'{name}.tar.gz' for name in backup.MOUNTS)]
        files = {}
        for name in names:
            (saved / name).write_bytes(b'fixture')
            files[name] = hashlib.sha256(b'fixture').hexdigest()
        (saved / 'manifest.json').write_text(json.dumps({'version': 1, 'files': files}))
        return saved

    def config(self, root):
        services = {}
        for service, target in backup.MOUNTS.values():
            services.setdefault(service, {'volumes': []})['volumes'].append({
                'target': target, 'type': 'bind', 'source': str(root / 'empty' / target.lstrip('/')),
            })
        return {'services': services}

    def test_corrupt_backup_is_rejected_before_restoring_payloads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            saved = self.fixture(root)
            (saved / 'novels.tar.gz').write_bytes(b'broken')
            with patch.object(sys, 'argv', ['backup', 'restore-empty', str(saved)]), \
                 patch.object(backup, 'output', return_value=json.dumps(self.config(root)).encode()), \
                 patch.object(backup, 'mount_command', return_value=['docker', '--entrypoint', 'tar']), \
                 patch.object(backup, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                    backup.main()
                run.assert_not_called()

    def test_nonempty_file_destination_is_rejected_before_database_start(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            saved = self.fixture(root)
            responses = [json.dumps(self.config(root)).encode(), b'', b'/data/existing-book.cbz']
            with patch.object(sys, 'argv', ['backup', 'restore-empty', str(saved)]), \
                 patch.object(backup, 'output', side_effect=responses), \
                 patch.object(backup, 'mount_command', return_value=['docker', '--entrypoint', 'tar']), \
                 patch.object(backup, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'nonempty destination'):
                    backup.main()
                run.assert_not_called()

    def test_nonempty_database_is_rejected_before_file_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            saved = self.fixture(root)
            responses = [json.dumps(self.config(root)).encode(), b'', *([b''] * len(backup.MOUNTS)), b'1']
            with patch.object(sys, 'argv', ['backup', 'restore-empty', str(saved)]), \
                 patch.object(backup, 'output', side_effect=responses), \
                 patch.object(backup, 'mount_command', return_value=['docker', '--entrypoint', 'tar']), \
                 patch.object(backup, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'nonempty database'):
                    backup.main()
                self.assertEqual(len(run.call_args_list), 1)
                self.assertEqual(run.call_args.args[0][-4:], ['up', '-d', '--wait', 'db'])

    def test_failed_dump_restarts_only_previously_running_writers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            commands = []
            def run(command, **kwargs):
                commands.append(command)
                if 'pg_dump' in command:
                    raise subprocess.CalledProcessError(1, command)
            responses = [json.dumps(self.config(root)).encode(), b'app\ndb\nnovel-engine\n']
            with patch.object(sys, 'argv', ['backup', 'backup', str(root / 'new-backup')]), \
                 patch.object(backup, 'output', side_effect=responses), \
                 patch.object(backup, 'mount_command', return_value=['docker', '--entrypoint', 'tar']), \
                 patch.object(backup, 'run', side_effect=run):
                with self.assertRaises(subprocess.CalledProcessError):
                    backup.main()
            self.assertEqual(commands[-1][-3:], ['start', 'app', 'novel-engine'])
            self.assertFalse((root / 'new-backup' / 'manifest.json').exists())


if __name__ == '__main__':
    unittest.main()
