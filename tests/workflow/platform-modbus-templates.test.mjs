import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createApplication, planApplicationUpdate, applyApplicationUpdate, parseTemplateBindings, pointSignature, decimal20Units } from '../../src/features/modbus-templates/bindings.ts';
import { createPlatformCatalog } from '../../src/features/modbus-templates/catalog-core.ts';
import { saveBoundTemplatePoints } from '../../src/features/modbus-templates/save-template.ts';
const template = JSON.parse(readFileSync(new URL('../fixtures/modbus-templates/aiswei-inverter-v2-1-5.json', import.meta.url), 'utf8'));
const source = {
  ...template,
  points: [{
    ...template.points[0],
    default_selected: true,
    condition: ''
  }]
};
const makeApp = () => createApplication({
  platformId: 'https://one',
  templateId: 'db-1',
  revision: '1',
  template: source,
  addressBase: 1,
  prefix: 'A_',
  selectedIds: [source.points[0].id],
  existingPoints: [],
  applicationId: 'app-1'
});
test('来源完整记录稳定ID和实际基线；非法来源不得静默丢失', () => {
  const {
    application,
    points
  } = makeApp();
  assert.equal(application.mappings[0].source_point_id, source.points[0].id);
  assert.deepEqual(application.mappings[0].baseline, points[0]);
  assert.equal(application.revision, '1');
  assert.throws(() => parseTemplateBindings('{oops'), /来源/);
});
test('三方比较跟随源ID处理标签和地址变动，现场冲突及删除默认保留', () => {
  const {
    application,
    points
  } = makeApp();
  const latest = {
    ...source,
    points: [{
      ...source.points[0],
      tag: '新版',
      address: source.points[0].address + 10
    }]
  };
  const clean = planApplicationUpdate(application, points, latest, '9007199254740994', 1);
  assert.equal(clean[0].kind, 'modified');
  assert.equal(clean[0].selected, true);
  const dirty = planApplicationUpdate(application, [{
    ...points[0],
    scale: 99,
    scale_decimal: '99'
  }], latest, '9007199254740994', 1);
  assert.equal(dirty[0].kind, 'conflict');
  assert.equal(dirty[0].selected, false);
  const deleted = planApplicationUpdate(application, points, {
    ...source,
    points: []
  }, '9007199254740994', 1);
  assert.equal(deleted[0].kind, 'deleted');
  assert.equal(deleted[0].selected, false);
});
test('部分接受不能推进整张模板版本，未处理差异仍可见', () => {
  const {
    application,
    points
  } = makeApp();
  const extra = {
    ...source.points[0],
    id: 'extra',
    tag: '新增',
    address: source.points[0].address + 20,
    default_selected: false
  };
  const latest = {
    ...source,
    points: [{
      ...source.points[0],
      scale: '2'
    }, extra]
  };
  const rows = planApplicationUpdate(application, points, latest, '2', 1);
  const result = applyApplicationUpdate(application, points, latest, '2', rows.filter(row => row.kind === 'modified').map(row => row.id), 1);
  assert.equal(result.application.revision, application.revision);
  assert.equal(planApplicationUpdate(result.application, result.points, latest, '2', 1).some(row => row.id === 'extra'), true);
});
test('缓存按平台隔离，必须有效登录且旧异步请求不得污染新会话', async () => {
  const cache = new Map();
  let authenticated = true;
  let identity = 'https://one';
  let fail = false;
  const summary = {
    id: 'db-1',
    revision: '1',
    name: source.name,
    manufacturer: 'x',
    models: [],
    protocol_version: '1',
    point_count: 1,
    updated_at: 1
  };
  const catalog = createPlatformCatalog({
    read: key => cache.get(key),
    write: (key, value) => cache.set(key, value),
    verify: async platform => {
      if (!authenticated || identity !== platform) throw Error('登录失效');
    },
    list: async () => {
      if (fail) throw Error('连接平台点表服务失败：离线');
      return [summary];
    },
    get: async () => ({
      id: 'db-1',
      revision: '1',
      template_json: JSON.stringify(source),
      created_at: 1,
      updated_at: 1
    })
  });
  await catalog.list(identity);
  await catalog.get(identity, 'db-1', '1');
  fail = true;
  assert.equal((await catalog.list(identity)).cached, true);
  identity = 'https://two';
  await assert.rejects(catalog.list(identity), /离线/);
  identity = 'https://one';
  authenticated = false;
  await assert.rejects(catalog.get(identity, 'db-1', '1'), /登录/);
});
test('旧下位机禁止来源应用；复读版本或来源变化时不得保存', async () => {
  const {
    application,
    points
  } = makeApp();
  const base = {
    conn_name: 'a',
    points,
    revision: '1',
    template_bindings_json: ''
  };
  const commit = {
    expected: base,
    points,
    bindings: {
      schema_version: 1,
      applications: [application]
    }
  };
  let saved = false;
  await assert.rejects(saveBoundTemplatePoints({
    ...commit,
    expected: {
      ...base,
      revision: '0'
    },
    read: async () => base,
    save: async () => {
      saved = true;
    }
  }), /不支持/);
  await assert.rejects(saveBoundTemplatePoints({
    ...commit,
    read: async () => ({
      ...base,
      revision: '2'
    }),
    save: async () => {
      saved = true;
    }
  }), /变化/);
  assert.equal(saved, false);
});
test('下位机固定20位回读、科学计数与精度舍入不产生现场假冲突', () => {
  const {
    application,
    points
  } = makeApp();
  const input = {
    ...points[0],
    scale: 0.1,
    scale_decimal: '0.100000000000000000004',
    offset_decimal: '-0.000000000000000000005',
    deadband_decimal: '1e-4'
  };
  application.mappings[0].baseline = input;
  application.mappings[0].source_snapshot = {
    ...source.points[0],
    scale: input.scale_decimal,
    offset: input.offset_decimal,
    deadband: input.deadband_decimal
  };
  const actual = {
    ...input,
    scale_decimal: '0.10000000000000000000',
    offset_decimal: '-0.00000000000000000001',
    deadband_decimal: '0.00010000000000000000'
  };
  const latest = {
    ...source,
    points: [{
      ...application.mappings[0].source_snapshot,
      address: input.address + 5
    }]
  };
  assert.equal(planApplicationUpdate(application, [actual], latest, '2', 1)[0].kind, 'modified');
  const changed = {
    ...actual,
    scale_decimal: '0.10000000000000000001'
  };
  assert.equal(planApplicationUpdate(application, [changed], latest, '2', 1)[0].kind, 'conflict');
});
test('仅明确选择的点位建立来源，初次未选择的旧点不误报新增', () => {
  const extra = {
    ...source.points[0],
    id: 'skipped',
    tag: '不需要',
    address: source.points[0].address + 50
  };
  const template = {
    ...source,
    points: [source.points[0], extra]
  };
  const initial = createApplication({
    platformId: 'https://one',
    templateId: 'db',
    revision: '1',
    template,
    addressBase: 1,
    prefix: '',
    selectedIds: [source.points[0].id],
    existingPoints: [],
    applicationId: 'app'
  });
  assert.deepEqual(planApplicationUpdate(initial.application, initial.points, template, '1', 1), []);
});
test('鉴权拒绝、删除及内容损坏不能回退历史缓存', async () => {
  const cache = new Map();
  let failure;
  const summary = {
    id: 'db-1',
    revision: '1',
    name: source.name,
    manufacturer: 'x',
    models: [],
    protocol_version: '1',
    point_count: 1,
    updated_at: 1
  };
  const catalog = createPlatformCatalog({
    read: key => cache.get(key),
    write: (key, value) => cache.set(key, value),
    verify: async () => {},
    list: async () => [summary],
    get: async () => {
      if (failure) throw Error(failure);
      return {
        id: 'db-1',
        revision: '1',
        template_json: JSON.stringify(source),
        created_at: 1,
        updated_at: 1
      };
    }
  });
  await catalog.get('https://one', 'db-1', '1');
  for (const reason of ['平台登录已失效', '没有权限', '模板不存在', '不支持的模板版本']) {
    failure = reason;
    await assert.rejects(catalog.get('https://one', 'db-1', '1'), new RegExp(reason));
  }
});
test('注销发生在目录请求过程中时丢弃异步响应且不写缓存', async () => {
  let finish;
  let valid = true;
  let writes = 0;
  const catalog = createPlatformCatalog({
    read: () => undefined,
    write: () => {
      writes++;
    },
    verify: async () => {
      if (!valid) throw Error('登录已变化');
    },
    list: () => new Promise(resolve => {
      finish = resolve;
    }),
    get: async () => assert.fail()
  });
  const request = catalog.list('https://one');
  await Promise.resolve();
  valid = false;
  finish([]);
  await assert.rejects(request, /登录已变化/);
  assert.equal(writes, 0);
});
test('语义签名对齐scale零默认、BOOL与默认端序，精确保留20位差异', () => {
  const {
    points
  } = makeApp();
  const point = points[0];
  assert.equal(pointSignature({
    ...point,
    scale: 0,
    scale_decimal: '0'
  }), pointSignature({
    ...point,
    scale: 1,
    scale_decimal: '1'
  }));
  assert.equal(pointSignature({
    ...point,
    data_type: 1,
    bit_index: null,
    enum_value: null,
    reg_count: 1,
    word_order: 0,
    byte_order: 0,
    scale_decimal: '9'
  }), pointSignature({
    ...point,
    data_type: 1,
    bit_index: null,
    enum_value: null,
    reg_count: 0,
    word_order: 1,
    byte_order: 1,
    scale_decimal: '1'
  }));
  assert.equal(decimal20Units('5e-21'), '1');
  assert.equal(decimal20Units('-5e-21'), '-1');
  assert.equal(decimal20Units('4e-21'), '0');
  assert.notEqual(decimal20Units('123456789012345678901.00000000000000000001'), decimal20Units('123456789012345678901.00000000000000000002'));
});
test('现场改名迁移目标关联但保留原基线，平台更新仍可明确覆盖', async () => {
  const {
    application,
    points
  } = makeApp();
  const {
    pointRenameSaveOptions
  } = await import('../../src/features/modbus-templates/save-template.ts');
  const actual = {
    conn_name: 'a',
    points,
    revision: '3',
    template_bindings_json: JSON.stringify({
      schema_version: 1,
      applications: [application]
    })
  };
  const metadata = await pointRenameSaveOptions({
    expectedPoints: points,
    oldTag: points[0].tag,
    newTag: '现场改名',
    read: async () => actual
  });
  const bindings = parseTemplateBindings(metadata.template_bindings_json);
  assert.equal(bindings.applications[0].mappings[0].target_tag, '现场改名');
  assert.equal(bindings.applications[0].mappings[0].baseline.tag, points[0].tag);
  const latest = {
    ...source,
    points: [{
      ...source.points[0],
      scale: '2'
    }]
  };
  const rows = planApplicationUpdate(bindings.applications[0], [{
    ...points[0],
    tag: '现场改名'
  }], latest, '4', 1);
  assert.equal(rows[0].kind, 'conflict');
  assert.equal(rows[0].blocked, undefined);
  const applied = applyApplicationUpdate(bindings.applications[0], [{
    ...points[0],
    tag: '现场改名'
  }], latest, '4', [rows[0].id], 1);
  assert.equal(applied.points.length, 1);
  assert.equal(applied.points[0].tag, points[0].tag);
});
test('部分更新接受删除后，同一源ID重新加入仍会显示新增', () => {
  const {
    application,
    points
  } = makeApp();
  const other = {
    ...source.points[0],
    id: 'new',
    tag: '另一个',
    address: source.points[0].address + 20,
    default_selected: false
  };
  const deleted = {
    ...source,
    points: [other]
  };
  const accepted = applyApplicationUpdate(application, points, deleted, '2', [source.points[0].id], 1);
  assert.equal(accepted.application.revision, application.revision);
  const restored = {
    ...source,
    points: [source.points[0], other]
  };
  assert.equal(planApplicationUpdate(accepted.application, accepted.points, restored, '3', 1).find(row => row.id === source.points[0].id)?.kind, 'added');
});
test('只有模板版本或说明变更时可确认版本而不改动现场点位', () => {
  const {
    application,
    points
  } = makeApp();
  const latest = {
    ...source,
    notes: ['平台修订适用说明']
  };
  assert.deepEqual(planApplicationUpdate(application, points, latest, '9007199254740994', 1), []);
  const updated = applyApplicationUpdate(application, points, latest, '9007199254740994', [], 1);
  assert.equal(updated.application.revision, '9007199254740994');
  assert.deepEqual(updated.points, points);
});
test('版本以uint64字符串精确保存，旧缓存不能倒退完整或部分已应用版本', () => {
  const {
    application,
    points
  } = makeApp();
  application.revision = '9007199254740993';
  application.mappings[0].source_revision = '9007199254740994';
  assert.equal(parseTemplateBindings(JSON.stringify({
    schema_version: 1,
    applications: [application]
  })).applications[0].revision, '9007199254740993');
  assert.throws(() => planApplicationUpdate(application, points, source, '9007199254740993', 1), /旧于已应用版本/);
});
test('历史版本只有明确选择后允许回退，接受后保留历史快照', () => {
  const {
    application,
    points
  } = makeApp();
  application.revision = '3';
  application.mappings[0].source_revision = '3';
  const previous = {
    ...source,
    points: [{
      ...source.points[0],
      scale: '0.1'
    }]
  };
  assert.throws(() => planApplicationUpdate(application, points, previous, '2', 1), /旧于已应用版本/);
  const rows = planApplicationUpdate(application, points, previous, '2', 1, true);
  const restored = applyApplicationUpdate(application, points, previous, '2', [rows[0].id], 1, true);
  assert.equal(restored.application.revision, '2');
  assert.equal(restored.points[0].scale_decimal, '0.1');
});
