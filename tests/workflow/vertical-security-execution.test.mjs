import assert from 'node:assert/strict';
import test from 'node:test';
import { getSecurityExecutionOutcome } from '../../src/utils/vertical-security-execution.ts';

const expected = Object.freeze(['precheck', 'local_security', 'ppp0_wait', 'remote_security_route', 'save_config']);
const step = (step_id, state = 'success', updated_at = 100) => ({ step_id, name: step_id, state, updated_at, message: '' });
const status = changes => ({
  service_name: 'mskdsp-vertical-security.service', active_state: 'active', sub_state: 'running',
  result: 'success', exit_code: 0, restart_count: 0,
  steps: expected.map(id => step(id)), ...changes,
});

test('部署后尚无状态为正在查询，查询失败为未知而不误标执行失败', () => {
  assert.deepEqual(getSecurityExecutionOutcome(null, expected), { phase: 'deployed', completed: false, failed: false, failedStep: null });
  assert.deepEqual(getSecurityExecutionOutcome(null, expected, true), { phase: 'unknown', completed: false, failed: false, failedStep: null });
});

test('PPP等待优先于残留的上轮全部成功步骤，不能显示已完成', () => {
  const snapshot = status({ steps: expected.map(id => id === 'ppp0_wait' ? step(id, 'waiting', 200) : step(id, 'success', 100)) });
  assert.deepEqual(getSecurityExecutionOutcome(snapshot, expected), { phase: 'waiting_ppp', completed: false, failed: false, failedStep: null });
});

test('重拨后PPP成功但配置保存仍为上轮记录时继续执行中', () => {
  const snapshot = status({ steps: expected.map(id => step(id, 'success', id === 'ppp0_wait' ? 200 : 100)) });
  assert.equal(getSecurityExecutionOutcome(snapshot, expected).phase, 'applying');
  assert.equal(getSecurityExecutionOutcome(snapshot, expected).completed, false);
});

test('服务重新执行早期步骤但PPP尚未更新时不能把上轮保存结果判为完成', () => {
  for (const changedId of ['precheck', 'local_security', 'remote_security_route']) {
    const snapshot = status({ steps: expected.map(id => step(id, 'success', id === changedId ? 200 : 100)) });
    assert.equal(getSecurityExecutionOutcome(snapshot, expected).phase, 'applying');
    snapshot.steps.find(item => item.step_id === 'save_config').updated_at = 200;
    assert.equal(getSecurityExecutionOutcome(snapshot, expected).phase, 'completed');
  }
});

test('本轮所有步骤成功且保存不早于PPP成功时完成，后台服务持续运行不影响判断', () => {
  for (const savedAt of [200, 201]) {
    const snapshot = status({ steps: expected.map(id => step(id, 'success', id === 'save_config' ? savedAt : 200)) });
    assert.deepEqual(getSecurityExecutionOutcome(snapshot, expected), { phase: 'completed', completed: true, failed: false, failedStep: null });
    assert.equal(snapshot.active_state, 'active');
    assert.equal(snapshot.sub_state, 'running');
  }
});

test('查询失败覆盖旧成功或旧失败快照，保留未知状态', () => {
  for (const snapshot of [status(), status({ active_state: 'failed', exit_code: 1 }), status({ steps: [step('precheck', 'failed')] })]) {
    assert.deepEqual(getSecurityExecutionOutcome(snapshot, expected, true), { phase: 'unknown', completed: false, failed: false, failedStep: null });
  }
});

test('步骤失败保留具体失败步骤，systemd失败及非零退出码分别标记失败', () => {
  const failedStep = step('local_security', 'failed');
  assert.deepEqual(getSecurityExecutionOutcome(status({ steps: [failedStep] }), expected), { phase: 'failed', completed: false, failed: true, failedStep });
  for (const failure of [{ active_state: 'failed' }, { sub_state: 'failed' }, { exit_code: 2 }]) {
    assert.deepEqual(getSecurityExecutionOutcome(status(failure), expected), { phase: 'failed', completed: false, failed: true, failedStep: null });
  }
});

test('缺少任一期望步骤、步骤尚在执行或无效时间戳时不能判定完成', () => {
  const snapshots = [
    status({ steps: expected.filter(id => id !== 'remote_security_route').map(id => step(id)) }),
    status({ steps: expected.map(id => step(id, id === 'remote_security_route' ? 'running' : 'success')) }),
    status({ steps: expected.map(id => step(id, 'success', id === 'save_config' ? Number.NaN : 100)) }),
    status({ steps: expected.map(id => step(id, 'success', id === 'ppp0_wait' ? Number.POSITIVE_INFINITY : 100)) }),
  ];
  for (const snapshot of snapshots) assert.equal(getSecurityExecutionOutcome(snapshot, expected).phase, 'applying');
  assert.equal(getSecurityExecutionOutcome(status(), []).phase, 'applying');
});

test('状态计算不修改输入快照或只读期望步骤', () => {
  const snapshot = status();
  const original = structuredClone(snapshot);
  snapshot.steps.forEach(Object.freeze); Object.freeze(snapshot.steps); Object.freeze(snapshot);
  getSecurityExecutionOutcome(snapshot, expected);
  assert.deepEqual(snapshot, original);
});
