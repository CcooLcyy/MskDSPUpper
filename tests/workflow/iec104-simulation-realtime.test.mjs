import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildIec104SimulationUpdates,
  resolveIec104RuntimeDisplay,
} from '../../src/pages/IEC104/simulation-realtime.ts';

const pageSource = readFileSync(new URL('../../src/pages/IEC104/index.tsx', import.meta.url), 'utf8');

const realtimeUpdate = {
  conn_id: 7,
  tag: '全站有功',
  value: { type: 'Double', value: 88.5 },
  ts_ms: 1_700_000_000_000,
  quality: 1,
  sequence: 9,
};

// 验证同一 Tag 同时存在实时值和模拟值时，运行视图选择模拟值与模拟时间。
test('IEC104 simulation values override DataCenter realtime values by tag', () => {
  const simulationUpdates = buildIec104SimulationUpdates({
    conn_name: '主站',
    points: [
      {
        tag: '全站有功',
        point_type: 1,
        bool_value: null,
        double_value: 1.25,
        quality: 0,
        ts_ms: 1_800_000_000_000,
      },
      {
        tag: '断路器状态',
        point_type: 2,
        bool_value: false,
        double_value: null,
        quality: 0,
        ts_ms: 1_800_000_000_001,
      },
    ],
  });

  assert.deepEqual(
    resolveIec104RuntimeDisplay('全站有功', simulationUpdates, realtimeUpdate),
    {
      update: {
        conn_id: 0,
        tag: '全站有功',
        value: { type: 'Double', value: 1.25 },
        ts_ms: 1_800_000_000_000,
        quality: 0,
        sequence: 0,
      },
      simulated: true,
    },
  );
  assert.deepEqual(
    resolveIec104RuntimeDisplay('断路器状态', simulationUpdates, undefined),
    {
      update: {
        conn_id: 0,
        tag: '断路器状态',
        value: { type: 'Bool', value: false },
        ts_ms: 1_800_000_000_001,
        quality: 0,
        sequence: 0,
      },
      simulated: true,
    },
  );
});

// 验证模拟快照不包含当前 Tag 时，运行视图保持 DataCenter 实时数据。
test('IEC104 runtime falls back to DataCenter when a tag has no simulation value', () => {
  const simulationUpdates = buildIec104SimulationUpdates({
    conn_name: '主站',
    points: [
      {
        tag: '断路器状态',
        point_type: 2,
        bool_value: true,
        double_value: null,
        quality: 0,
        ts_ms: 1_800_000_000_001,
      },
    ],
  });

  assert.deepEqual(
    resolveIec104RuntimeDisplay('全站有功', simulationUpdates, realtimeUpdate),
    {
      update: realtimeUpdate,
      simulated: false,
    },
  );
});

// 验证 IEC104 运行视图接入模拟值选择逻辑，并在质量列标识模拟数据。
test('IEC104 runtime columns use the simulation display resolver', () => {
  assert.match(pageSource, /buildIec104SimulationUpdates\(activeSimulationSnapshot\)/);
  assert.match(pageSource, /simulationSnapshot\?\.conn_name === selectedConn/);
  assert.equal((pageSource.match(/resolveIec104RuntimeDisplay\(/g) ?? []).length, 3);
  assert.match(
    pageSource,
    /display\.simulated[\s\S]*<Tag color="warning">模拟<\/Tag>[\s\S]*renderProtocolRealtimeQualityCell\(display\.update/,
  );
  assert.match(pageSource, /const actionsDisabled = simulationLoading/);
  assert.match(pageSource, /setSimulationSnapshot\(\{ conn_name: selectedConn, points: \[\] \}\)/);
});

// 验证模拟面板提供四种遥信模式，并将所选模式传给生成接口。
test('IEC104 simulation panel exposes deterministic boolean modes', () => {
  assert.match(pageSource, /boolMode: simulationBoolMode/);
  assert.match(pageSource, /value: 'random', label: '遥信随机值'/);
  assert.match(pageSource, /value: 'all_true', label: '遥信全部 true'/);
  assert.match(pageSource, /value: 'all_false', label: '遥信全部 false'/);
  assert.match(pageSource, /value: 'invert_current', label: '遥信按当前值取反'/);
  assert.match(pageSource, /当前模拟值[\s\S]*DataCenter 最新值[\s\S]*缺少当前值/);
});
