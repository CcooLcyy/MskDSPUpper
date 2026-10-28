import test from 'node:test';
import assert from 'node:assert/strict';
import { getAccessCheckRevision, invalidateAccessCheck, reportLoginConnectionFailure, subscribeAccessCheckInvalidation } from '../../src/pages/SecurityAccess/access-state.ts';

const result = stage => ({ mode: 'direct', target_ip: '11.22.33.44', steps: [{ id: stage, state: 'failed' }] });

test('登录连接或 TLS 失败立即通知检查页并使旧异步结果过期', () => {
  let notified = 0;
  const unsubscribe = subscribeAccessCheckInvalidation(() => { notified += 1; });
  const requestRevision = getAccessCheckRevision();
  reportLoginConnectionFailure(result('connect'));
  assert.notEqual(getAccessCheckRevision(), requestRevision);
  reportLoginConnectionFailure(result('tls'));
  assert.equal(notified, 2);
  unsubscribe();
  invalidateAccessCheck();
  assert.equal(notified, 2);
});

test('账号认证失败或初始化失败不误判为连接不可用', () => {
  const revision = getAccessCheckRevision();
  reportLoginConnectionFailure(result('authenticate'));
  reportLoginConnectionFailure(result('initialize'));
  reportLoginConnectionFailure({ ...result('connect'), steps: [{ id: 'connect', state: 'success' }] });
  assert.equal(getAccessCheckRevision(), revision);
});

test('其他目标或远程连接失败不撤销直连检查结果', () => {
  const revision = getAccessCheckRevision();
  reportLoginConnectionFailure({ ...result('connect'), target_ip: '192.0.2.1' });
  reportLoginConnectionFailure({ ...result('connect'), mode: 'remote' });
  assert.equal(getAccessCheckRevision(), revision);
});
