import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const protocols = [
  ['ModbusRTU', 'modbusRtuDeleteLink'],
  ['ModbusTCP', 'modbusTcpDeleteLink'],
  ['DLT645', 'dlt645DeleteLink'],
];

function findNode(root, predicate) {
  if (predicate(root)) return root;
  return ts.forEachChild(root, (node) => findNode(node, predicate));
}

function loadCallbacks(protocol) {
  const path = new URL(`../../src/pages/${protocol}/index.tsx`, import.meta.url);
  const source = ts.createSourceFile(path.pathname, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = findNode(source, (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === 'handleDeleteLink');
  const title = findNode(source, (node) => ts.isJsxAttribute(node) && node.name.getText(source) === 'getDeleteTitle');
  assert.ok(declaration && title, '页面必须提供删除操作与确认提示');
  return {
    handler: declaration.initializer.arguments[0].getText(source),
    title: title.initializer.expression.getText(source),
  };
}

function compileCallback(expression, environment) {
  const compiled = ts.transpileModule(`const callback = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(...Object.keys(environment), `${compiled}\nreturn callback;`)(...Object.values(environment));
}

function createEnvironment(operation, state = 2, mutation = null) {
  const calls = [];
  const environment = {
    links: [{ config: { conn_name: '连接一' }, state }],
    selectedConn: '连接一',
    linkMutation: mutation,
    setLinkMutation: (value) => calls.push(['mutation', value]),
    setSelectedConn: (value) => calls.push(['selection', value]),
    refreshLinks: async () => calls.push(['refresh']),
    messageApi: Object.fromEntries(['success', 'warning', 'error'].map((kind) => [kind, (text) => calls.push([kind, text])])),
    api: { [operation]: async (name) => calls.push(['delete', name]) },
  };
  return { environment, calls };
}

for (const [protocol, operation] of protocols) {
  const callbacks = loadCallbacks(protocol);

  // 验证运行态与停止态均直接删除，接口未完成时不提前清除选择或显示成功。
  test(`${protocol} 运行态与停止态均等待下位机删除完成`, async () => {
    for (const state of [2, 1]) {
      const { environment, calls } = createEnvironment(operation, state);
      let complete;
      environment.api[operation] = (name) => {
        calls.push(['delete', name]);
        return new Promise((resolve) => { complete = resolve; });
      };
      const pending = compileCallback(callbacks.handler, environment)('连接一');
      assert.deepEqual(calls, [['mutation', 'delete'], ['delete', '连接一']]);
      complete();
      await pending;
      assert.equal(calls.filter(([kind]) => kind === 'delete').length, 1);
      assert.ok(calls.some(([kind, value]) => kind === 'selection' && value === null));
      assert.ok(calls.some(([kind]) => kind === 'success'));
      assert.ok(calls.some(([kind]) => kind === 'refresh'));
      assert.deepEqual(calls.at(-1), ['mutation', null]);
    }
  });

  // 验证下位机清理失败后刷新实际状态、保留选择，不显示删除成功也不自动重试。
  test(`${protocol} 删除失败保留选择并刷新待删除状态`, async () => {
    const { environment, calls } = createEnvironment(operation);
    environment.api[operation] = async (name) => {
      calls.push(['delete', name]);
      environment.links[0].state = 3;
      throw new Error('DataCenter 清理失败，连接待删除');
    };
    await compileCallback(callbacks.handler, environment)('连接一');
    assert.equal(calls.filter(([kind]) => kind === 'delete').length, 1);
    assert.ok(calls.some(([kind, text]) => kind === 'error' && text.includes('连接待删除')));
    assert.ok(calls.some(([kind]) => kind === 'refresh'));
    assert.ok(!calls.some(([kind]) => kind === 'selection' || kind === 'success'));
    assert.deepEqual(calls.at(-1), ['mutation', null]);
  });

  // 验证已有复制或删除操作期间不再发送删除请求。
  test(`${protocol} 操作进行中阻止重复删除`, async () => {
    for (const mutation of ['delete', 'copy']) {
      const { environment, calls } = createEnvironment(operation, 2, mutation);
      await compileCallback(callbacks.handler, environment)('连接一');
      assert.deepEqual(calls, []);
    }
  });

  // 验证运行态明确确认停止并删除，停止态仍提示普通删除且包含目标名称。
  test(`${protocol} 删除确认区分运行态与停止态`, () => {
    for (const state of [2, 1]) {
      const { environment } = createEnvironment(operation, state);
      const title = compileCallback(callbacks.title, environment)('连接一');
      assert.ok(title.includes('连接一'));
      assert.ok(title.includes('删除'));
      if (state === 2) assert.ok(title.includes('正在运行') && title.includes('停止'));
      else assert.ok(!title.includes('正在运行') && !title.includes('停止'));
    }
  });
}
