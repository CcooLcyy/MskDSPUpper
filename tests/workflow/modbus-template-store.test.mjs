import assert from 'node:assert/strict';
import test from 'node:test';
import { createPersonalTemplateStore } from '../../src/features/modbus-templates/store-core.ts';
import { createTemplateFromPoints, planTemplateApplication } from '../../src/features/modbus-templates/model.ts';
const native = {tag:'电压',function:2,address:1,data_type:2,reg_count:1,scale:1,offset:0,deadband:0,
  scale_decimal:'1',offset_decimal:'0',deadband_decimal:'0',word_order:0,byte_order:0,bit_index:null};
const make = (id) => createTemplateFromPoints({id,name:id,addressBase:1,points:[native]});

// 大模板不能被旧目录总量拦截，目录总量仍须有限且写失败不影响已有快照。
test('可保存超过旧 10 MiB 总量的目录，超过 50 MiB 时保留旧目录', async () => {
  const makeLarge = (id) => {
    const data = createTemplateFromPoints({ id, name: id, addressBase: 1,
      points: Array.from({ length: 1600 }, (_, index) => ({ ...native, tag: `点位${index}`, address: index })) });
    for (const item of data.points) item.description = 'x'.repeat(4096);
    return data;
  };
  let saved = [];
  const store = createPersonalTemplateStore([], { read: () => saved, write: async value => { saved = value; } });
  await store.save(makeLarge('large0'));
  await store.save(makeLarge('large1'));
  assert.ok(Buffer.byteLength(JSON.stringify(saved), 'utf8') > 10 * 1024 * 1024);
  for (let index = 2; index < 7; index += 1) await store.save(makeLarge(`large${index}`));
  const previous = saved;
  await assert.rejects(store.save(makeLarge('large7')), /50 MiB/);
  assert.equal(saved, previous);
  assert.equal(store.list().length, 7);
});
test('个人模板持久化重载、禁止内置覆盖与重复ID、删除只影响个人模板', async () => {
  let saved = [];
  const store = createPersonalTemplateStore([make('builtin')], {read:()=>saved,write:async value => {saved=value;}});
  await store.save(make('one'));
  assert.equal(store.list().length,1);
  assert.equal(planTemplateApplication(store.list()[0],{existingPoints:[],addressBase:1}).points[0].tag,'电压');
  await assert.rejects(store.save(make('builtin')),/内置/);
  await assert.rejects(store.save(make('one')),/重复/);
  await assert.rejects(store.remove('builtin'),/内置/);
  await store.remove('one');
  assert.deepEqual(saved,[]);
});
test('并发写入不丢模板，写失败不改变持久化快照且后续可重试', async () => {
  let saved=[];
  let fail=false;
  const store=createPersonalTemplateStore([], {read:()=>saved,write:async value=>{if(fail)throw new Error('磁盘不可写');saved=value;}});
  await Promise.all([store.save(make('a')),store.save(make('b'))]);
  assert.deepEqual(saved.map(t=>t.id),['a','b']);
  fail=true;
  await assert.rejects(store.save(make('c')),/磁盘/);
  assert.deepEqual(store.list().map(t=>t.id),['a','b']);
  fail=false;
  await store.save(make('c'));
  assert.deepEqual(store.list().map(t=>t.id),['a','b','c']);
});
test('损坏持久化值拒绝加载，个人目录拒绝超量或重复模板', async () => {
  const store=createPersonalTemplateStore([], {read:()=>({points:[]}),write:async()=>{}});
  assert.throws(()=>store.list(),/目录/);
  const duplicate=createPersonalTemplateStore([], {read:()=>[make('same'),make('same')],write:async()=>{}});
  assert.throws(()=>duplicate.list(),/重复/);
  const oversized=createPersonalTemplateStore([], {read:()=>Array.from({length:101},(_,i)=>make(`p${i}`)),write:async()=>{}});
  assert.throws(()=>oversized.list(),/100/);
});
