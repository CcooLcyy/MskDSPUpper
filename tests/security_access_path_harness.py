"""使用假网络命令执行实际脚本，不连接设备或真实网络。

Linux/WSL 运行：python3 tests/security_access_path_harness.py
仅将 root 锁文件路径替换为临时目录，其余执行实际脚本。
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'src-tauri/src/commands/security_access_path.sh'
FAKE = r'''#!/usr/bin/env python3
import json, os, pathlib, stat, sys
p = pathlib.Path(os.environ['FAKE_STATE'])
s = json.loads(p.read_text())
name = pathlib.Path(sys.argv[0]).name
a = sys.argv[1:]
rc, out, mutation = 0, '', False
if name == 'id': out = '0'
elif name == 'flock': pass
elif name == 'stat':
    try:
        metadata = os.lstat(a[-1])
        values = {'%u': str(s.get('file_uid', 0)), '%a': format(stat.S_IMODE(metadata.st_mode), 'o'), '%h': str(metadata.st_nlink)}
        out = a[1]
        for token, value in values.items(): out = out.replace(token, value)
    except OSError: rc = 1
elif name == 'sysctl':
    if a[0] == '-n': out = s['sysctls'][a[1]]
    else:
        key, val = a[1].split('='); s['sysctls'][key] = val; mutation = True
        if key == 'net.ipv4.ip_forward' and s.get('reset_proxy'):
            s['sysctls']['net.ipv4.conf.eth0/101.proxy_arp'] = '0'
elif name == 'ip':
    if a[:3] == ['-o', 'link', 'show']:
        out = '2: ' + a[-1] + ': <BROADCAST,%s> mtu 1500' % ('LOWER_UP' if s.get('link_down') else 'UP,LOWER_UP')
    elif a[:4] == ['-o', '-4', 'address', 'show']:
        out = '\n'.join('2: %s inet %s scope global' % tuple(x) for x in s['addresses'])
    elif a[:5] == ['-4', 'route', 'show', 'table', 'all']:
        out = '\n'.join(s['routes'])
    elif a[:3] == ['-4', 'route', 'get']:
        out = '11.22.33.44 dev %s src 11.22.33.2' % s.get('actual_dev', 'eth0.108')
    elif a[:2] in (['address', 'add'], ['address', 'del']):
        item = [a[4], a[2]]; mutation = True
        if a[1] == 'add': s['addresses'].append(item)
        else: s['addresses'].remove(item)
    elif a[:2] in (['route', 'add'], ['route', 'del']):
        item = ' '.join(a[2:]); mutation = True
        if a[1] == 'add': s['routes'].append(item)
        else: s['routes'].remove(item)
    else: rc = 97
elif name == 'iptables':
    i = next(i for i, v in enumerate(a) if v in ('-C', '-I', '-D'))
    op = a[i]; rule = a[:i] + a[i+1:]
    if op == '-I': rule.pop(i+1)
    rule = ' '.join(rule)
    if op == '-C': rc = s.get('check_error', 0 if rule in s['rules'] else 1)
    elif op == '-I': s['rules'].append(rule); mutation = True
    else: s['rules'].remove(rule); mutation = True
else: rc = 98
s['calls'].append([name] + a)
if mutation:
    s['mutations'].append([name] + a)
    if s.get('fail_once') and name == 'iptables' and '-I' in a:
        # 模拟原子命令失败，返回错误前撤销本条操作。
        s['rules'].remove(rule); s['fail_once'] = False; rc = 7
p.write_text(json.dumps(s))
if out: print(out)
sys.exit(rc)
'''


class AccessPathShellTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.state = self.dir / 'state.json'
        self.initial = dict(addresses=[], routes=[], rules=[], calls=[], mutations=[], sysctls={
            'net.ipv4.ip_forward': '0', 'net.ipv4.conf.eth0/101.proxy_arp': '0'})
        self.state.write_text(json.dumps(self.initial))
        for name in ('ip', 'iptables', 'sysctl', 'flock', 'id', 'stat'):
            tool = self.dir / name
            tool.write_text(FAKE)
            tool.chmod(0o755)

    def run_script(self):
        text = SCRIPT.read_text().replace('/run/mskdsp-vertical-security-access.lock', str(self.dir / 'lock'))
        return subprocess.run(['/bin/bash', '-c', text], env={**os.environ,
            'PATH': str(self.dir) + ':' + os.environ['PATH'], 'FAKE_STATE': str(self.state)},
            capture_output=True, text=True, timeout=15)

    def read(self):
        return json.loads(self.state.read_text())

    def test_apply_and_repeat_are_idempotent(self):
        first = self.run_script()
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        s = self.read()
        self.assertEqual(len(s['addresses']), 2)
        self.assertEqual(len(s['routes']), 2)
        self.assertEqual(len(s['rules']), 3)
        n = len(s['mutations'])
        second = self.run_script()
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertEqual(len(self.read()['mutations']), n)
        self.assertIn('MSKDSP_PATH|result|success', second.stdout)

    def test_conflict_fails_before_any_mutation(self):
        for field, value in [('addresses', [['eth0.107', '11.22.33.1/32']]),
                             ('addresses', [['eth0.108', '11.22.33.44/32']]),
                             ('routes', ['11.22.33.44 via 192.168.1.1 dev eth0.101']),
                             ('routes', ['blackhole 11.22.33.44/32']),
                             ('routes', ['11.22.33.44 dev eth0.108 src 192.168.1.2'])]:
            with self.subTest(field=field):
                s = {**self.initial, field: value}
                self.state.write_text(json.dumps(s))
                result = self.run_script()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.read()['mutations'], [])
                self.assertIn('MSKDSP_PATH|preflight|failed', result.stdout)

    def test_failed_apply_rolls_back_only_new_state(self):
        s = {**self.initial, 'addresses': [['eth0.101', '11.22.33.1/32']],
             'routes': ['11.22.33.0/24 dev eth0.101 src 11.22.33.1 scope link'], 'fail_once': True}
        self.state.write_text(json.dumps(s))
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        after = self.read()
        for key in ('addresses', 'routes', 'rules'):
            self.assertEqual(after[key], s[key], key)
        self.assertEqual(after['sysctls']['net.ipv4.ip_forward'], '1')
        self.assertIn('MSKDSP_PATH|rollback|partial', result.stdout)

    def test_rollback_does_not_disable_shared_ipv4_forwarding(self):
        self.state.write_text(json.dumps({**self.initial, 'fail_once': True}))
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        after = self.read()
        self.assertEqual(after['sysctls']['net.ipv4.ip_forward'], '1')
        self.assertFalse(any(call == ['sysctl', '-w', 'net.ipv4.ip_forward=0'] for call in after['calls']))

    def test_policy_route_wrong_output_does_not_report_success(self):
        self.state.write_text(json.dumps({**self.initial, 'actual_dev': 'eth0.101'}))
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('MSKDSP_PATH|verification|failed', result.stdout)
        self.assertNotIn('MSKDSP_PATH|result|success', result.stdout)

    def test_existing_vlan_parent_suffix_is_accepted_without_duplicate_address(self):
        self.state.write_text(json.dumps({**self.initial, 'addresses': [
            ['eth0.101@eth0', '11.22.33.1/32'], ['eth0.108@eth0', '11.22.33.2/32']]}))
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(any(call[:3] == ['ip', 'address', 'add'] for call in self.read()['calls']))

    def test_interface_down_and_firewall_errors_are_preflight_failures(self):
        for field, value in [('link_down', True), ('check_error', 2)]:
            with self.subTest(field=field):
                self.state.write_text(json.dumps({**self.initial, field: value}))
                result = self.run_script()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.read()['mutations'], [])
                self.assertIn('MSKDSP_PATH|preflight|failed', result.stdout)

    def test_forwarding_change_reapplies_proxy_after_kernel_defaults_reset(self):
        s = {**self.initial, 'reset_proxy': True, 'sysctls': {
            'net.ipv4.ip_forward': '0', 'net.ipv4.conf.eth0/101.proxy_arp': '1'}}
        self.state.write_text(json.dumps(s))
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.read()['sysctls']['net.ipv4.conf.eth0/101.proxy_arp'], '1')


if __name__ == '__main__':
    unittest.main()
