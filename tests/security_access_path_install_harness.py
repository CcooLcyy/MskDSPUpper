"""独立维护安装事务的本地命令桩；不调用真实 systemd 或网络命令。"""
import json
import os
from pathlib import Path
import subprocess
import unittest

import security_access_path_harness as runtime_fixture

ROOT, SCRIPT = runtime_fixture.ROOT, runtime_fixture.SCRIPT

INSTALL = ROOT / 'src-tauri/src/commands/security_access_path_install.sh'
SYSTEMCTL = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
p = pathlib.Path(os.environ['FAKE_STATE']); s = json.loads(p.read_text()); a = sys.argv[1:]
root = pathlib.Path(os.environ['FAKE_SYSTEM'])
unit = root / 'etc/systemd/system/mskdsp-vertical-security-access.service'
wants = root / 'etc/systemd/system/multi-user.target.wants/mskdsp-vertical-security-access.service'
rc, out = 0, ''
if a[0] == 'show':
    prop = next(x.split('=',1)[1] for x in a if x.startswith('--property='))
    out = {'Version':'fixture', 'LoadState': 'loaded' if unit.exists() else 'not-found',
           'FragmentPath':s.get('fragment',str(unit) if unit.exists() else ''), 'DropInPaths':s.get('dropins',''),
           'ActiveState':s.get('active','inactive')}[prop]
elif a[0] == 'is-enabled':
    out = 'enabled' if wants.is_symlink() else ('disabled' if unit.exists() else 'not-found')
    rc = 0 if out == 'enabled' else 1
elif a[0] == 'daemon-reload': pass
elif a[0] == 'enable':
    if s.get('fail_enable'): rc = 1
    else:
        wants.parent.mkdir(exist_ok=True)
        if not wants.is_symlink(): wants.symlink_to('../mskdsp-vertical-security-access.service')
elif a[0] == 'disable':
    if wants.is_symlink(): wants.unlink()
else: rc = 98
s['calls'].append(['systemctl'] + a); p.write_text(json.dumps(s))
if out: print(out)
sys.exit(rc)
'''
WRITER = r'''#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys
p=pathlib.Path(os.environ['FAKE_STATE']); s=json.loads(p.read_text()); a=sys.argv[1:]
name=pathlib.Path(sys.argv[0]).name
s['calls'].append([name]+a); p.write_text(json.dumps(s))
if name=='mv' and s.get('fail_write') and a[-1].endswith('/mskdsp-vertical-security-access.service'):
    s['fail_write']=False; p.write_text(json.dumps(s)); sys.exit(7)
if name=='rm' and s.get('fail_cleanup'):
    s['fail_cleanup']=False; p.write_text(json.dumps(s)); sys.exit(7)
if name=='chown': sys.exit(0)
os.execv('/usr/bin/'+name,[name]+a)
'''


class AccessPathInstallTest(unittest.TestCase):
    def setUp(self):
        runtime_fixture.AccessPathShellTest.setUp(self)
        self.system = self.dir / 'system'
        for relative in ['usr/local/lib', 'etc/systemd/system', 'run']:
            (self.system / relative).mkdir(parents=True, exist_ok=True)
        self.nsswitch=self.system/'etc/nsswitch.conf'
        self.nsswitch.write_text('passwd: files systemd\ngroup: files systemd\n')
        for name, body in [('systemctl', SYSTEMCTL), ('mv', WRITER), ('chown', WRITER), ('rm', WRITER)]:
            tool = self.dir / name; tool.write_text(body); tool.chmod(0o755)

    def mapped(self, text):
        for prefix in ['/usr', '/etc', '/run']:
            text = text.replace(prefix, str(self.system) + prefix)
        return text

    def read(self):
        return json.loads(self.state.read_text())

    def run_install(self):
        text = INSTALL.read_text().replace('__MSKDSP_RUNTIME_PAYLOAD__', SCRIPT.read_text().rstrip('\n'))
        return subprocess.run(['/bin/bash', '--noprofile', '--norc', '-s'], input=self.mapped(text), env={**os.environ,
            'PATH':str(self.dir)+':'+os.environ['PATH'], 'FAKE_STATE':str(self.state), 'FAKE_SYSTEM':str(self.system)},
            capture_output=True, text=True, timeout=20)

    def installed_runtime(self):
        return self.system / 'usr/local/lib/mskdsp-vertical-security-access/apply.sh'

    def unit(self):
        return self.system / 'etc/systemd/system/mskdsp-vertical-security-access.service'

    def make_system_ancestors_775(self):
        for relative in ['usr','usr/local','usr/local/lib','etc','etc/systemd','etc/systemd/system']:
            (self.system/relative).chmod(0o775)

    def test_site_root_root_775_ancestors_allow_install_with_trusted_root_group(self):
        self.make_system_ancestors_775()
        result=self.run_install()
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertIn('MSKDSP_PATH|persistence|success',result.stdout)

    def test_normal_755_ancestors_do_not_require_nss(self):
        self.state.write_text(json.dumps({**self.initial,'getent_fail':'all'}))
        self.nsswitch.unlink()
        result=self.run_install()
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertFalse(any(call[0]=='getent' for call in self.read()['calls']))

    def test_initgroups_may_return_name_only_or_only_supplementary_groups(self):
        self.make_system_ancestors_775()
        passwd='root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\noperator:x:1000:1000:operator:/home/operator:/bin/bash'
        self.state.write_text(json.dumps({**self.initial,'passwd':passwd,'initgroups':{'daemon':'daemon    ','operator':'operator 27'}}))
        result=self.run_install()
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)

    def test_initgroups_missing_name_wrong_name_or_zero_group_is_rejected(self):
        self.make_system_ancestors_775()
        for output in ['', '   ', 'another-user 1', 'daemon 0']:
            with self.subTest(output=output):
                self.state.write_text(json.dumps({**self.initial,'initgroups':{'daemon':output}}))
                result=self.run_install()
                self.assertNotEqual(result.returncode,0)
                self.assertIn('MSKDSP_PATH|detail|root_group_untrusted',result.stdout)
                self.assertEqual(self.read()['mutations'],[])

    def test_remote_nss_source_with_unenumerated_gid_zero_user_is_rejected(self):
        self.make_system_ancestors_775()
        self.nsswitch.write_text('passwd: files sss\ngroup: files sss\n')
        self.state.write_text(json.dumps({**self.initial,'initgroups':{'hidden_remote':'hidden_remote 0'}}))
        result=self.run_install()
        self.assertNotEqual(result.returncode,0)
        self.assertIn('MSKDSP_PATH|detail|root_group_untrusted',result.stdout)
        self.assertFalse(any(call[0]=='getent' for call in self.read()['calls']))
        self.assertEqual(self.read()['mutations'],[])

    def test_unknown_incomplete_complex_or_untrusted_nsswitch_is_rejected(self):
        self.make_system_ancestors_775()
        for config in ['passwd: files\n','group: files\n','passwd: files\ngroup: files\ninitgroups: ldap\n',
            'passwd: files [SUCCESS=return] systemd\ngroup: files\n',
            'passwd: files\npasswd: files\ngroup: files\n','passwd: systemd files\ngroup: files\n']:
            with self.subTest(config=config):
                self.nsswitch.write_text(config)
                self.state.write_text(json.dumps(self.initial))
                result=self.run_install()
                self.assertNotEqual(result.returncode,0)
                self.assertEqual(self.read()['mutations'],[])
        self.nsswitch.write_text('passwd: files\ngroup: files\ninitgroups: files systemd\n')
        for override,mode in [({'path_uid':{str(self.nsswitch):1000}},0o644),({},0o664)]:
            with self.subTest(override=override,mode=mode):
                self.nsswitch.chmod(mode); self.state.write_text(json.dumps({**self.initial,**override}))
                self.assertNotEqual(self.run_install().returncode,0)
                self.assertEqual(self.read()['mutations'],[])

    def test_files_only_and_optional_local_initgroups_sources_are_supported(self):
        self.make_system_ancestors_775()
        for config in ['passwd: files\ngroup: files\n',
            '# local NSS\n passwd : files systemd # supported\ngroup: files\ninitgroups: files systemd\n']:
            with self.subTest(config=config):
                self.nsswitch.write_text(config)
                result=self.run_install()
                self.assertEqual(result.returncode,0,result.stdout+result.stderr)

    def test_missing_or_symbolic_nsswitch_cannot_enable_group_write_exception(self):
        self.make_system_ancestors_775()
        self.nsswitch.unlink()
        missing=self.run_install()
        self.assertNotEqual(missing.returncode,0)
        self.assertIn('MSKDSP_PATH|detail|root_group_untrusted',missing.stdout)
        foreign=self.dir/'foreign-nsswitch'; foreign.write_text('passwd: files\ngroup: files\n')
        self.nsswitch.symlink_to(foreign)
        linked=self.run_install()
        self.assertNotEqual(linked.returncode,0)
        self.assertIn('MSKDSP_PATH|detail|root_group_untrusted',linked.stdout)
        self.assertEqual(self.read()['mutations'],[])

    def test_root_group_exception_rejects_untrusted_primary_supplementary_or_nss_failure(self):
        self.make_system_ancestors_775()
        for detail,override in [
            ('primary',{'passwd':'root:x:0:0:root:/root:/bin/bash\nordinary:x:1000:0:ordinary:/home/ordinary:/bin/sh'}),
            ('supplementary',{'groups':'root:x:0:daemon\ndaemon:x:1:'}),
            ('dynamic-supplementary',{'initgroups':{'daemon':'daemon 1 0'}}),
            ('group-alias',{'groups':'root:x:0:\nalias:x:0:daemon\ndaemon:x:1:'}),
            ('missing-member',{'groups':'root:x:0:missing\ndaemon:x:1:'}),
            ('group-query',{'getent_fail':'group'}),
            ('passwd-query',{'getent_fail':'passwd'}),
            ('initgroups-query',{'getent_fail':'initgroups'}),
        ]:
            with self.subTest(detail=detail):
                self.state.write_text(json.dumps({**self.initial,**override}))
                result=self.run_install()
                self.assertNotEqual(result.returncode,0)
                self.assertIn('MSKDSP_PATH|detail|root_group_untrusted',result.stdout)
                self.assertEqual(self.read()['mutations'],[])

    def test_ancestor_exception_rejects_nonroot_owner_group_other_write_acl_and_read_errors(self):
        path=self.system/'usr'
        for detail,mode,override in [
            ('owner',0o775,{'path_uid':{str(path):1000}}),
            ('group',0o775,{'path_gid':{str(path):50}}),
            ('other-write',0o777,{}),
            ('acl',0o775,{'acl_paths':[str(path)]}),
            ('acl-755',0o755,{'acl_paths':[str(path)]}),
            ('stat-read',0o775,{'stat_fail_paths':[str(path)]}),
            ('ls-read',0o775,{'ls_fail_paths':[str(path)]}),
        ]:
            with self.subTest(detail=detail):
                path.chmod(mode)
                self.state.write_text(json.dumps({**self.initial,**override}))
                result=self.run_install()
                self.assertNotEqual(result.returncode,0)
                self.assertIn('MSKDSP_PATH|detail|directory_usr',result.stdout)
                self.assertEqual(self.read()['mutations'],[])

    def test_managed_directory_remains_strict_even_with_trusted_root_group(self):
        self.assertEqual(self.run_install().returncode,0)
        (self.system/'usr/local/lib/mskdsp-vertical-security-access').chmod(0o775)
        n=len(self.read()['mutations'])
        result=self.run_install()
        self.assertNotEqual(result.returncode,0)
        self.assertIn('MSKDSP_PATH|detail|directory_managed',result.stdout)
        self.assertEqual(len(self.read()['mutations']),n)

    def test_run_directory_and_lock_remain_strict(self):
        run=self.system/'run'; run.chmod(0o775)
        result=self.run_install()
        self.assertNotEqual(result.returncode,0)
        self.assertIn('MSKDSP_PATH|detail|directory_run',result.stdout)
        self.assertEqual(self.read()['mutations'],[])
        run.chmod(0o755)
        lock=run/'mskdsp-vertical-security-access.lock'; lock.write_text(''); lock.chmod(0o666)
        result=self.run_install()
        self.assertNotEqual(result.returncode,0)
        self.assertIn('MSKDSP_PATH|detail|directory_run',result.stdout)
        self.assertEqual(self.read()['mutations'],[])

    def test_install_repeat_and_simulated_boot_restore(self):
        first = self.run_install()
        self.assertEqual(first.returncode, 0, first.stdout+first.stderr)
        self.assertIn('MSKDSP_PATH|persistence|success', first.stdout)
        self.assertIn('Restart=on-failure', self.unit().read_text())
        self.assertIn('StartLimitIntervalSec=0', self.unit().read_text())
        self.assertIn('RestartSec=15', self.unit().read_text())
        self.assertIn('network-online.target', self.unit().read_text())
        self.assertNotIn('ppp', self.unit().read_text().lower())
        n = len(self.read()['mutations'])
        second = self.run_install()
        self.assertEqual(second.returncode, 0, second.stdout+second.stderr)
        self.assertEqual(len(self.read()['mutations']), n)
        current = self.read()
        for key in ['addresses', 'routes', 'rules']: current[key] = []
        current['sysctls'] = self.initial['sysctls']; current['link_down'] = True
        self.state.write_text(json.dumps(current))
        env = {**os.environ, 'PATH':str(self.dir)+':'+os.environ['PATH'], 'FAKE_STATE':str(self.state)}
        pending = subprocess.run(['/bin/bash', str(self.installed_runtime())], env=env, capture_output=True, text=True)
        self.assertNotEqual(pending.returncode, 0)
        current = self.read(); current['link_down'] = False; self.state.write_text(json.dumps(current))
        ready = subprocess.run(['/bin/bash', str(self.installed_runtime())], env=env, capture_output=True, text=True)
        self.assertEqual(ready.returncode, 0, ready.stdout+ready.stderr)
        self.assertEqual(len(self.read()['addresses']), 2)

    def test_service_failure_restores_previous_install_and_enabled_state(self):
        self.assertEqual(self.run_install().returncode, 0)
        original_runtime = self.installed_runtime().read_bytes(); original_unit = self.unit().read_bytes()
        current = self.read(); current['fail_enable'] = True; current['active'] = 'active'; self.state.write_text(json.dumps(current))
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('MSKDSP_PATH|result|success', result.stdout)
        self.assertEqual(self.installed_runtime().read_bytes(), original_runtime)
        self.assertEqual(self.unit().read_bytes(), original_unit)
        self.assertEqual(self.read()['active'], 'active')
        self.assertFalse(any(c[:2] in [['systemctl','stop'],['systemctl','restart']] for c in self.read()['calls']))

    def test_first_install_write_or_enable_failure_is_not_success(self):
        for field in ['fail_write', 'fail_enable']:
            with self.subTest(field=field):
                self.state.write_text(json.dumps({**self.initial, field:True}))
                result = self.run_install()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('MSKDSP_PATH|persistence|failed', result.stdout)
                self.assertFalse(self.unit().exists())
                self.assertFalse(self.installed_runtime().exists())
                self.assertEqual(self.read()['addresses'], [])

    def test_foreign_file_symlink_or_dropin_is_rejected_before_network_change(self):
        foreign = self.dir / 'foreign'; foreign.write_text('foreign-data')
        self.unit().symlink_to(foreign)
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.read()['mutations'], [])
        self.assertEqual(foreign.read_text(), 'foreign-data')
        self.unit().unlink(); self.unit().write_text('# foreign service\n')
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.read()['mutations'], [])

    def test_managed_service_dropin_is_not_overwritten(self):
        self.assertEqual(self.run_install().returncode, 0)
        current = self.read(); n = len(current['mutations']); current['dropins']='/unknown/override.conf'
        self.state.write_text(json.dumps(current))
        self.assertNotEqual(self.run_install().returncode, 0)
        self.assertEqual(len(self.read()['mutations']), n)

    def test_foreign_fragment_or_wants_target_is_rejected(self):
        self.assertEqual(self.run_install().returncode, 0)
        current = self.read(); n = len(current['mutations']); current['fragment']='/unknown/foreign.service'
        self.state.write_text(json.dumps(current))
        self.assertNotEqual(self.run_install().returncode, 0)
        self.assertEqual(len(self.read()['mutations']), n)
        current = self.read(); del current['fragment']; self.state.write_text(json.dumps(current))
        wants = self.system / 'etc/systemd/system/multi-user.target.wants/mskdsp-vertical-security-access.service'
        wants.unlink(); wants.symlink_to('/unknown/foreign.service')
        self.assertNotEqual(self.run_install().returncode, 0)
        self.assertEqual(len(self.read()['mutations']), n)

    def test_root_ancestor_symlink_cannot_redirect_install(self):
        directory = self.system / 'usr/local/lib'
        directory.rmdir()
        foreign = self.dir / 'foreign-dir'; foreign.mkdir()
        directory.symlink_to(foreign, target_is_directory=True)
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('MSKDSP_PATH|detail|directory_usr_local_lib', result.stdout)
        self.assertEqual(self.read()['mutations'], [])
        self.assertEqual(list(foreign.iterdir()), [])

    def test_managed_marker_without_matching_hash_or_single_link_is_rejected(self):
        self.assertEqual(self.run_install().returncode, 0)
        original = self.unit().read_bytes(); n = len(self.read()['mutations'])
        self.unit().write_bytes(original+b'# changed outside feature\n')
        self.assertNotEqual(self.run_install().returncode, 0)
        self.assertEqual(len(self.read()['mutations']), n)
        self.unit().write_bytes(original)
        os.link(self.installed_runtime(), self.dir/'unexpected-hard-link')
        self.assertNotEqual(self.run_install().returncode, 0)
        self.assertEqual(len(self.read()['mutations']), n)

    def test_real_cross_process_lock_blocks_install_before_network_change(self):
        import fcntl
        (self.dir/'flock').unlink()
        lock = self.system / 'run/mskdsp-vertical-security-access.lock'
        with lock.open('w') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.read()['mutations'], [])

    def test_cleanup_failure_keeps_configuration_but_never_reports_success(self):
        self.state.write_text(json.dumps({**self.initial, 'fail_cleanup': True}))
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('MSKDSP_PATH|rollback|retained', result.stdout)
        self.assertIn('MSKDSP_PATH|persistence|failed', result.stdout)
        self.assertNotIn('MSKDSP_PATH|result|success', result.stdout)
        self.assertTrue(self.installed_runtime().exists())
        self.assertTrue(self.unit().exists())

    def test_corrupt_gzip_cannot_be_hidden_by_successful_empty_bash(self):
        result = subprocess.run(['/bin/bash','-c',
            "set -euo pipefail; printf '%s' 'bm90LWd6aXA=' | base64 -d | gzip -d | bash --noprofile --norc -s"],
            capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
