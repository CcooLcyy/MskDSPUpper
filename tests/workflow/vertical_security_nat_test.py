"""仅在临时目录中执行生成的业务脚本，所有网络命令均为命令桩。"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

FAKE = r'''#!/usr/bin/python3
import json,os,signal,sys,time
from pathlib import Path
path=Path(os.environ['NAT_STATE'])
state=json.loads(path.read_text())
name=Path(sys.argv[0]).name;args=sys.argv[1:]
state['calls'].append([name]+args)
code=0;output=''
if name=='ip':
    if args[:3]==['-4','rule','show']:
        output='\n'.join(state.get('policy_rules',[]))
    elif args[:3]==['-4','rule','add']:
        state.setdefault('policy_rules',[]).append('19900: from all iif eth0.107 lookup 18685')
    elif 'show' in args and 'ppp0' in args:
        if state['ppp'] is None:code=1
        elif 'link' in args:output=str(state['index'])+': ppp0: <POINTOPOINT,UP> mtu 1500'
        else:output=str(state['index'])+': ppp0 inet '+state['ppp']+'/32 scope global ppp0'
    elif args[:2]==['link','show']:output='12: fixture: <UP> mtu 1500'
    elif args[:2]==['route','replace'] and 'table' in args:
        state.setdefault('policy_routes',[]).append(args[2:])
    elif args[:2] not in (['addr','replace'],['route','replace']):code=72
elif name=='iptables':
    nat=args[:2]==['-t','nat']
    if nat:args=args[2:]
    rules=state['rules'] if nat else state.setdefault('filter_rules',[])
    operation=args[0];rule=args[1:]
    if operation=='-I' and len(rule)>1 and rule[1].isdigit():rule=[rule[0]]+rule[2:]
    if operation=='-C':code=0 if rule in rules else 1
    elif operation=='-D':
        if rule in rules:rules.remove(rule)
        else:code=1
    elif operation=='-A':rules.append(rule)
    elif operation=='-I':rules.insert(0,rule)
    else:code=73
elif name=='sysctl':
    if args[0]=='-w':
        for assignment in args[1:]:
            key,value=assignment.split('=',1);state['settings'][key]=value
            output+=assignment+'\n'
    elif args[0]=='-n':output=state['settings'].get(args[1],'600')
    else:code=74
elif name=='sleep':
    if args==['30']:
        state['refreshes']+=1
        if state['scenario']=='error':code=42
        if state['scenario']=='terminate':state['stop_signal']=True
        if state['scenario']=='interrupted_migration' and state.get('interrupt_once'):
            state['interrupt_once']=False
            state['stop_signal']=True
    elif args==['5']:
        state['ticks']+=1
        if state['scenario']=='watch':
            phases={1:(None,16),2:('10.9.1.202',17),3:('10.9.1.202',17),
                    4:('10.9.1.202',18),5:(None,18),6:('10.9.1.202',19),7:('10.9.1.202',19)}
            state['ppp'],state['index']=phases.get(state['ticks'],('10.9.1.202',19))
            if state['ticks']>=8:state['stop_signal']=True
        if state['scenario']=='initial_wait':state['ppp']='10.9.1.201'
    else:code=75
else:code=76
stop_signal=state.pop('stop_signal',False)
path.write_text(json.dumps(state))
if output:print(output)
if stop_signal:
    os.kill(os.getppid(),signal.SIGTERM)
    time.sleep(0.02)
sys.exit(code)
'''


def dnat(public, private):
    return ['PREROUTING', '-i', 'ppp0', '-d', public, '-j', 'DNAT', '--to-destination', private]


def snat(public, private, remote, legacy=False):
    return ['POSTROUTING', '-o', 'ppp0'] + (['-p', '253'] if legacy else []) + [
        '-s', private+'/32', '-d', remote+'/32', '-j', 'SNAT', '--to-source', public]


def route_107(state, ppp_available):
    # 按命令桩记录的策略及路由模拟内核选择；PPP 消失后依附接口的路由不再可用。
    if '19900: from all iif eth0.107 lookup 18685' not in state.get('policy_rules', []):
        return '684'
    candidates = []
    for route in state.get('policy_routes', []):
        if route[route.index('table') + 1] != '18685':
            continue
        if route[0] == 'unreachable':
            candidates.append((int(route[route.index('metric') + 1]), 'unreachable'))
        elif ppp_available and 'ppp0' in route:
            candidates.append((int(route[route.index('metric') + 1]), 'ppp0'))
    return min(candidates)[1] if candidates else '684'


def main():
    request = json.load(sys.stdin)
    scenario = request['scenario']
    with tempfile.TemporaryDirectory(prefix='msk-vertical-nat-') as directory:
        root = Path(directory)
        binaries = root/'bin'
        binaries.mkdir()
        for command in ('ip', 'iptables', 'sysctl', 'sleep'):
            target = binaries/command
            target.write_text(FAKE, encoding='utf8')
            target.chmod(0o755)
        config = root/'config'
        config.mkdir()
        status = root/'status'
        script = request['script'].replace("readonly CONFIG_DIR='/etc/mskdsp'", "readonly CONFIG_DIR='"+str(config)+"'")
        script = script.replace("readonly STATUS_DIR='/run/mskdsp-vertical-security'", "readonly STATUS_DIR='"+str(status)+"'")
        assert "CONFIG_DIR='/etc/mskdsp'" not in script, '配置目录必须隔离'
        assert "STATUS_DIR='/run/mskdsp-vertical-security'" not in script, '状态目录必须隔离'
        script_path = root/'apply.sh'
        script_path.write_text(script, encoding='utf8')
        maintenance = ['POSTROUTING', '-o', 'eth0.108', '-s', '11.22.33.0/24', '-d', '11.22.33.44/32', '-j', 'SNAT', '--to-source', '11.22.33.2']
        unrelated = snat('10.9.1.201', '10.10.9.20', '10.20.9.20')
        state = {'ppp': '10.9.1.201', 'index': 16, 'rules': [maintenance, unrelated],
                 'settings': {'net.netfilter.nf_conntrack_generic_timeout': '600'},
                 'calls': [], 'ticks': 0, 'refreshes': 0, 'scenario': scenario}
        if scenario == 'initial_wait':
            state['ppp'] = None
        if scenario == 'migrate':
            state['rules'] += [dnat('10.9.1.199', '10.99.1.20'),
                               snat('10.9.1.199', '10.99.1.20', '10.99.2.20'),
                               snat('10.9.1.199', '10.99.1.20', '10.99.2.20', True),
                               snat('10.9.1.201', '10.10.1.20', '10.20.1.20', True),
                               dnat('10.9.1.201', '10.10.1.20'), dnat('10.9.1.201', '10.10.1.20'),
                               snat('10.9.1.201', '10.10.1.20', '10.20.1.20'),
                               snat('10.9.1.201', '10.10.1.20', '10.20.1.20')]
            (config/'vertical-security.conf').write_text(
                'PPP0_ADDRESS=10.9.1.199\nLOCAL_SECURITY_ADDRESS=10.99.1.20\nREMOTE_SECURITY_ADDRESS=10.99.2.20\n')
        if scenario == 'interrupted_migration':
            state.update(ppp='10.9.1.202', index=17, interrupt_once=True)
            state['rules'] += [dnat('10.9.1.201', '10.10.1.20'),
                               snat('10.9.1.201', '10.10.1.20', '10.20.1.20')]
            (config/'vertical-security.conf').write_text(
                'PPP0_ADDRESS=10.9.1.201\nLOCAL_SECURITY_ADDRESS=10.10.1.20\nREMOTE_SECURITY_ADDRESS=10.20.1.20\n')
        state_path = root/'state.json'
        state_path.write_text(json.dumps(state))
        environment = dict(os.environ, PATH=str(binaries)+':'+os.environ['PATH'], NAT_STATE=str(state_path))
        for attempt in range(2 if scenario in ('repeated', 'interrupted_migration') else 1):
            result = subprocess.run(['bash', str(script_path)]+(['--watch-ppp'] if scenario == 'watch' else []),
                                    env=environment, capture_output=True, text=True, timeout=20)
            if scenario in ('error', 'terminate', 'watch') or (scenario == 'interrupted_migration' and attempt == 0):
                assert result.returncode != 0, '异常或终止必须退出'
            else:
                assert result.returncode == 0, result.stdout+'\n'+result.stderr
            if scenario == 'interrupted_migration' and attempt == 0:
                interrupted = json.loads(state_path.read_text())
                assert interrupted['settings']['net.netfilter.nf_conntrack_generic_timeout'] == '600'
                assert snat('10.9.1.202', '10.10.1.20', '10.20.1.20') in interrupted['rules'], '确认中间地址规则已安装后才中断'
                assert 'PPP0_ADDRESS=10.9.1.201' in (config/'vertical-security.conf').read_text(), '中断时正式配置仍是P1'
                interrupted.update(ppp='10.9.1.203', index=18)
                state_path.write_text(json.dumps(interrupted))
        state = json.loads(state_path.read_text())
        # 普通出口存在时，107 转发仍必须固定查 PPP 专表，断线时以不可达路由阻止串到普通出口。
        assert ['ip', 'route', 'replace', 'unreachable', 'default', 'table', '18685', 'metric', '32760'] in state['calls'], '缺少 PPP 断线隔离路由'
        assert any(call[:4] == ['ip', '-4', 'rule', 'add'] and 'eth0.107' in call and '18685' in call for call in state['calls']), '缺少 107 入站策略路由'
        if scenario not in ('error', 'terminate'):
            assert ['ip', 'route', 'replace', 'default', 'dev', 'ppp0', 'table', '18685', 'metric', '10'] in state['calls'], 'PPP 恢复后必须维护专用出口'
            assert route_107(state, True) == 'ppp0', '107 密文必须选用 PPP 出口'
        assert route_107(state, False) == 'unreachable', 'PPP 消失后密文不能回落到 684'
        for source, target in [('eth0.107', 'ppp0'), ('ppp0', 'eth0.107')]:
            rule = ['FORWARD', '-i', source, '-o', target, '-j', 'ACCEPT']
            assert state.get('filter_rules', []).count(rule) == 1, 'Docker 默认拒绝转发时需要幂等的纵密双向放行'
        assert state['settings']['net.netfilter.nf_conntrack_generic_timeout'] == '600', '退出后必须恢复600秒'
        assert maintenance in state['rules'] and unrelated in state['rules'], '不能删除其他业务或维护规则'
        assert not any(call[0]=='ip' and call[1:3] in (['addr','flush'], ['route','flush']) for call in state['calls'])
        if scenario not in ('error', 'terminate'):
            public = '10.9.1.203' if scenario == 'interrupted_migration' else '10.9.1.202' if scenario == 'watch' else '10.9.1.201'
            expected = [maintenance, unrelated, dnat(public, '10.10.1.20'), snat(public, '10.10.1.20', '10.20.1.20')]
            assert sorted(state['rules']) == sorted(expected), '最终NAT不正确或存在重复旧规则: '+json.dumps(state['rules'])
            saved = (config/'vertical-security.conf').read_text()
            assert 'PPP0_ADDRESS='+public in saved, '必须保存最新PPP地址'
            assert not (config/'vertical-security-nat.pending').exists(), '完整保存成功后必须清除待恢复NAT账本'
        if scenario == 'watch':
            assert state['refreshes'] == 4, '仅初次、换IP及同IP重连刷新，稳定轮询不能重复刷新'
            route_calls = [call for call in state['calls'] if call[:4] == ['ip','route','replace','10.20.1.20/32']]
            assert len(route_calls) == 4, '每次重连必须恢复业务PPP路由'
            assert 'waiting' in (status/'steps.log').read_text(), '断线应报告等待'
        if scenario == 'repeated':
            assert state['refreshes'] == 2
        if scenario == 'initial_wait':
            assert state['ticks'] == 1, '初始等待后应完成单次应用并退出'
        if scenario == 'error':
            assert 'failed' in (status/'steps.log').read_text(), '刷新失败不能显示成功'
        print(json.dumps({'scenario': scenario, 'passed': True, 'refreshes': state['refreshes']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
