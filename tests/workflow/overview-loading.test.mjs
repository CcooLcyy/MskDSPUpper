import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadDashboardAfterRunningModules } from '../../src/utils/dashboard-loading.ts';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

// 验证运行模块地址尚未刷新时，不会提前请求依赖模块地址的配置。
test('dashboard waits for running module addresses before loading module configuration', async () => {
  const runningModules = deferred();
  const calls = [];
  const loadPromise = loadDashboardAfterRunningModules({
    getModuleInfo: async () => [],
    getRunningModuleInfo: () => runningModules.promise,
    listIec104Links: async () => calls.push('IEC104'),
    listModbusLinks: async () => calls.push('ModbusRTU'),
    listDlt645Links: async () => calls.push('DLT645'),
    listAgcGroups: async () => calls.push('AGC'),
    listRoutes: async () => calls.push('DataCenter'),
  });

  await Promise.resolve();
  assert.deepEqual(calls, []);

  runningModules.resolve([]);
  const result = await loadPromise;

  assert.deepEqual(calls.sort(), ['AGC', 'DLT645', 'DataCenter', 'IEC104', 'ModbusRTU'].sort());
  assert.equal(result.runningModules.status, 'fulfilled');
});

// 验证运行模块地址刷新失败时跳过所有模块配置请求，并保留失败结果供页面提示。
test('dashboard skips module configuration when running module refresh fails', async () => {
  const calls = [];
  const refreshError = new Error('ModuleManager 不可用');
  const result = await loadDashboardAfterRunningModules({
    getModuleInfo: async () => [],
    getRunningModuleInfo: async () => {
      throw refreshError;
    },
    listIec104Links: async () => calls.push('IEC104'),
    listModbusLinks: async () => calls.push('ModbusRTU'),
    listDlt645Links: async () => calls.push('DLT645'),
    listAgcGroups: async () => calls.push('AGC'),
    listRoutes: async () => calls.push('DataCenter'),
  });

  assert.deepEqual(calls, []);
  assert.equal(result.runningModules.status, 'rejected');
  assert.equal(result.iec104Links.status, 'rejected');
  assert.equal(result.modbusLinks.status, 'rejected');
});

// 验证地址刷新完成后各配置分区仍并发加载，单个失败不会阻断其余结果。
test('dashboard keeps partial configuration results after address refresh', async () => {
  const result = await loadDashboardAfterRunningModules({
    getModuleInfo: async () => [{ module_name: 'ModuleManager' }],
    getRunningModuleInfo: async () => [{ module_name: 'ModbusRTU' }],
    listIec104Links: async () => {
      throw new Error('IEC104 不可用');
    },
    listModbusLinks: async () => [{ conn_name: 'meter-1' }],
    listDlt645Links: async () => [],
    listAgcGroups: async () => [],
    listRoutes: async () => [{ src: {}, dst: {} }],
  });

  assert.equal(result.iec104Links.status, 'rejected');
  assert.equal(result.modbusLinks.status, 'fulfilled');
  assert.equal(result.routes.status, 'fulfilled');
});
