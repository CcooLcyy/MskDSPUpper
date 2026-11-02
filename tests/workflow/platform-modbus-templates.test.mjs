import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createApplication, planApplicationUpdate, applyApplicationUpdate, parseTemplateBindings, pointSignature, decimal20Units, planTemplateSourceTransfers as transferPlan } from '../../src/features/modbus-templates/bindings.ts';
import { planTemplateApplication } from '../../src/features/modbus-templates/model.ts';
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

const bindingsOf = (...applications) => ({ schema_version: 1, applications });
const transferSource = {
  ...source,
  points: [source.points[0], ...['保留现场', '删除但未重加', '初次未选'].map((tag, index) => ({
    ...source.points[0], id: `transfer-${index}`, tag, address: source.points[0].address + (index + 1) * 20
  }))]
};
const makeTransferApp = (options = {}) => createApplication({
  platformId: 'https://one', templateId: 'db-old', revision: '1', template: transferSource,
  addressBase: 1, prefix: '', selectedIds: transferSource.points.slice(0, 3).map(point => point.id),
  existingPoints: [], applicationId: 'transfer-old', ...options
});

// 验证现场已删除点位重加时只迁移来源，不破坏旧记录或产生重复标签。
test('删除后作为新模板应用同标签点位，合并来源可正常解析且不修改输入', () => {
  const old = makeApp();
  const next = createApplication({
    platformId: 'https://one', templateId: 'db-1', revision: '2', template: source,
    addressBase: 1, prefix: 'A_', selectedIds: [source.points[0].id], existingPoints: [], applicationId: 'app-new'
  });
  const bindings = bindingsOf(old.application);
  const before = structuredClone({ bindings, current: [], additions: next.points });
  const planned = transferPlan(bindings, [], next.points);
  assert.deepEqual(planned.transfers, [{ target_tag: old.points[0].tag, application_id: 'app-1', source_point_id: source.points[0].id }]);
  assert.deepEqual(planned.bindings.applications[0].mappings, []);
  assert.ok(planned.bindings.applications[0].excluded_source_ids.includes(source.points[0].id));
  const combined = bindingsOf(...planned.bindings.applications, next.application);
  assert.equal(parseTemplateBindings(JSON.stringify(combined)).applications.length, 2);
  assert.deepEqual({ bindings, current: [], additions: next.points }, before);
});

// 验证华为101点模板明确选择13点删除后能完整重建来源，不假定截图中的具体ID。
test('华为101点模板选择13点删除后重加，旧映射迁移且新映射无重复', () => {
  const huawei = JSON.parse(readFileSync(new URL('../fixtures/modbus-templates/huawei-sun2000-three-v3-02.json', import.meta.url), 'utf8'));
  assert.equal(huawei.points.length, 101);
  const selectedIds = planTemplateApplication(huawei, { existingPoints: [], addressBase: 1 }).rows.filter(row => row.selected && !row.conflict).slice(0, 13).map(row => row.id);
  assert.equal(selectedIds.length, 13);
  const make = applicationId => createApplication({
    platformId: 'https://one', templateId: 'huawei', revision: '1', template: huawei,
    addressBase: 1, prefix: '', selectedIds, existingPoints: [], applicationId
  });
  const old = make('huawei-old');
  const next = make('huawei-new');
  const planned = transferPlan(bindingsOf(old.application), [], next.points);
  assert.equal(planned.transfers.length, 13);
  assert.equal(planned.bindings.applications[0].mappings.length, 0);
  assert.equal(new Set(planned.bindings.applications[0].excluded_source_ids).size, 101);
  const merged = parseTemplateBindings(JSON.stringify(bindingsOf(...planned.bindings.applications, next.application)));
  assert.equal(merged.applications[1].mappings.length, 13);
});

// 验证迁移仅针对本次实际新增标签，现场仍在及删除后未选择的旧映射都保留。
test('部分删除后重加仅迁移选中标签，保留现场点及未选择的删除点来源', () => {
  const old = makeTransferApp();
  const bindings = bindingsOf(old.application);
  const before = structuredClone(bindings);
  const planned = transferPlan(bindings, [old.points[1]], [old.points[0]]);
  assert.deepEqual(planned.transfers.map(item => item.target_tag), [old.points[0].tag]);
  assert.deepEqual(planned.bindings.applications[0].mappings, old.application.mappings.slice(1));
  assert.deepEqual(new Set(planned.bindings.applications[0].excluded_source_ids), new Set([transferSource.points[3].id, transferSource.points[0].id]));
  assert.deepEqual(bindings, before);
});

// 验证来源归属按目标标签处理，支持从另一模板移交已删除的同名点。
test('跨模板同名点的旧来源可以迁移，不改动无关应用', () => {
  const old = makeApp();
  const unrelated = makeTransferApp();
  const otherSource = { ...source, id: 'another-template', points: [{ ...source.points[0], id: 'another-source' }] };
  const next = createApplication({
    platformId: 'https://two', templateId: 'other-db', revision: '1', template: otherSource,
    addressBase: 1, prefix: 'A_', selectedIds: ['another-source'], existingPoints: [], applicationId: 'other-app'
  });
  const planned = transferPlan(bindingsOf(old.application, unrelated.application), [], next.points);
  assert.equal(planned.transfers[0].source_point_id, source.points[0].id);
  assert.deepEqual(planned.bindings.applications[1], unrelated.application);
  const parsed = parseTemplateBindings(JSON.stringify(bindingsOf(...planned.bindings.applications, next.application)));
  assert.equal(parsed.applications[2].mappings[0].source_point_id, 'another-source');
});

// 验证真实现场重复必须阻断并显示具体标签，不把现有点位误当成失效映射。
test('现场存在同名点时阻止迁移并报告标签，包括没有来源的手工点', () => {
  const old = makeApp();
  for (const bindings of [bindingsOf(old.application), bindingsOf()]) {
    const before = structuredClone(bindings);
    assert.throws(() => transferPlan(bindings, old.points, old.points), error => {
      assert.ok(error.message.includes(old.points[0].tag));
      return true;
    });
    assert.deepEqual(bindings, before);
  }
});

// 验证迁移后旧模板的后续版本不能重新认领标签，包括新点再次被现场删除之后。
test('旧模板更新及新点再次删除后都不重新认领已经迁移的源ID', () => {
  const old = makeApp();
  const transferred = transferPlan(bindingsOf(old.application), [], old.points).bindings.applications[0];
  const latest = { ...source, points: [{ ...source.points[0], scale: '2', tag: '平台新版名称' }] };
  for (const current of [old.points, []]) {
    assert.deepEqual(planApplicationUpdate(transferred, current, latest, '2', 1), []);
    const updated = applyApplicationUpdate(transferred, current, latest, '2', [], 1);
    assert.deepEqual(updated.points, current);
    assert.deepEqual(planApplicationUpdate(updated.application, [], latest, '3', 1), []);
  }
});

// 验证缺少排除列表的旧格式先按原快照推导初次未选项，再追加迁移源ID。
test('旧格式无excluded时保持初次未选点排除，并保留仍有关联的来源', () => {
  const old = makeTransferApp();
  delete old.application.excluded_source_ids;
  const planned = transferPlan(bindingsOf(old.application), [old.points[1]], [old.points[0]]);
  const app = planned.bindings.applications[0];
  assert.deepEqual(new Set(app.excluded_source_ids), new Set([transferSource.points[0].id, transferSource.points[3].id]));
  assert.deepEqual(app.mappings, old.application.mappings.slice(1));
  const latest = { ...transferSource, points: transferSource.points.map(point => ({ ...point, scale: '2' })) };
  const rows = planApplicationUpdate(app, [old.points[1]], latest, '2', 1);
  assert.deepEqual(new Set(rows.map(row => row.id)), new Set(transferSource.points.slice(1, 3).map(point => point.id)));
  assert.equal(old.application.excluded_source_ids, undefined);
});

// 验证首次应用与没有选择新增点位时不清理任何历史来源。
test('首次无来源或没有本次新增标签时返回无迁移且保持原绑定内容', () => {
  const old = makeApp();
  const empty = bindingsOf();
  assert.deepEqual(transferPlan(empty, [], old.points), { bindings: empty, transfers: [] });
  const bindings = bindingsOf(old.application);
  assert.deepEqual(transferPlan(bindings, [], []), { bindings, transfers: [] });
  const unique = old.points.map(point => ({ ...point, tag: `新前缀_${point.tag}` }));
  assert.deepEqual(transferPlan(bindings, [], unique), { bindings, transfers: [] });
});

// 验证来源迁移与新增点位一同提交；版本过期不保存，保存失败不修改原来源快照。
test('重新添加的点位和迁移来源沿用版本保护，失败不单独清理旧记录', async () => {
  const old = makeApp();
  const originalBindings = bindingsOf(old.application);
  const expected = { conn_name: '逆变器', revision: '7', points: [], template_bindings_json: JSON.stringify(originalBindings) };
  const next = createApplication({
    platformId: 'https://one', templateId: 'db-1', revision: '2', template: source,
    addressBase: 1, prefix: 'A_', selectedIds: [source.points[0].id], existingPoints: [], applicationId: 'new-app'
  });
  const migration = transferPlan(originalBindings, expected.points, next.points);
  const commit = { expected, points: next.points, bindings: bindingsOf(...migration.bindings.applications, next.application) };
  const before = structuredClone({ expected, originalBindings });
  let saveCalls = 0;
  await assert.rejects(saveBoundTemplatePoints({ ...commit,
    read: async () => ({ ...expected, revision: '8' }),
    save: async () => { saveCalls++; }
  }), /已变化/);
  assert.equal(saveCalls, 0);
  await assert.rejects(saveBoundTemplatePoints({ ...commit,
    read: async () => expected,
    save: async (points, metadata) => {
      saveCalls++;
      assert.deepEqual(points, next.points);
      assert.equal(metadata.expected_revision, '7');
      const saved = parseTemplateBindings(metadata.template_bindings_json);
      assert.deepEqual(saved.applications[0].mappings, []);
      assert.deepEqual(saved.applications[1].mappings, next.application.mappings);
      throw Error('设备拒绝保存');
    }
  }), /设备拒绝保存/);
  assert.equal(saveCalls, 1);
  assert.deepEqual({ expected, originalBindings }, before);
});

// 验证损坏或未迁移的重复来源报出具体标签，方便定位。
test('模板来源重复校验明确指出被重复关联的标签', () => {
  const old = makeApp();
  const duplicate = { ...old.application, application_id: 'other-app' };
  assert.throws(() => parseTemplateBindings(JSON.stringify(bindingsOf(old.application, duplicate))), error => {
    assert.ok(error.message.includes('映射重复'));
    assert.ok(error.message.includes(old.points[0].tag));
    return true;
  });
});
