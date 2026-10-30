import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const protocolConnectionSource = readFileSync(
  new URL('../../src/components/protocol/ProtocolConnectionList.tsx', import.meta.url),
  'utf8',
);
const protocolPageStyles = readFileSync(
  new URL('../../src/components/protocol/protocol-page.css', import.meta.url),
  'utf8',
);
const iec61850Styles = readFileSync(new URL('../../src/pages/IEC61850/index.css', import.meta.url), 'utf8');
const dataBusSource = readFileSync(new URL('../../src/pages/DataBus/index.tsx', import.meta.url), 'utf8');
const dataBusStyles = readFileSync(new URL('../../src/pages/DataBus/index.css', import.meta.url), 'utf8');
const agcSource = readFileSync(new URL('../../src/pages/AGC/index.tsx', import.meta.url), 'utf8');
const avcSource = readFileSync(new URL('../../src/pages/AVC/index.tsx', import.meta.url), 'utf8');
const controlGroupListSource = readFileSync(
  new URL('../../src/components/control/ControlGroupList.tsx', import.meta.url),
  'utf8',
);

// 按选择器读取声明，避免在无关容器的样式中误匹配到滚动属性。
function dataBusRule(selector) {
  const rule = [...dataBusStyles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(([, selectors]) => selectors.split(',').some((item) => item.trim() === selector));
  assert.ok(rule, `缺少数据总线样式规则：${selector}`);
  return Object.fromEntries(rule[2].split(';').filter((item) => item.trim()).map((declaration) => {
    const colon = declaration.indexOf(':');
    return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
  }));
}

// 验证协议连接列表的卡片、内容区和滚动层都允许在有限高度内收缩。
test('协议连接列表保留受限高度滚动链路', () => {
  assert.match(protocolConnectionSource, /className="protocol-connection-list-card"/);
  assert.match(protocolConnectionSource, /minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden'/);
  assert.match(protocolConnectionSource, /className="protocol-connection-list-scroll" style=\{\{ flex: '1 1 auto', minHeight: 0, minWidth: 0, overflowY: 'auto'/);
  assert.match(protocolPageStyles, /\.protocol-connection-list-card > \.ant-card-body[\s\S]*?min-height: 0;[\s\S]*?overflow: hidden;/);
});

// 验证 IEC61850 IED 列表的 Card body 本身是可收缩的滚动容器。
test('IEC61850 IED 列表支持受限高度滚动', () => {
  assert.match(iec61850Styles, /\.iec61850-list \{ height: 100%; display: flex; flex-direction: column; \}/);
  assert.match(iec61850Styles, /\.iec61850-list > \.ant-card-body \{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-height: 0;[\s\S]*?overflow-y: auto;/);
});

// 验证 AGC 和 AVC 控制组列表不会因 Flex 最小高度而撑出父面板。
test('AGC 和 AVC 控制组列表支持内部滚动', () => {
  assert.match(agcSource, /<ControlGroupList[\s\S]*items=\{controlGroupListItems\}/);
  assert.match(avcSource, /<ControlGroupList[\s\S]*items=\{controlGroupListItems\}/);
  assert.match(
    controlGroupListSource,
    /minHeight: 0, flex: '1 1 auto', display: 'flex', flexDirection: 'column', overflow: 'hidden'/,
  );
  assert.match(
    controlGroupListSource,
    /body: \{ flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden'/,
  );
  assert.match(controlGroupListSource, /minHeight: 0, overflowY: 'auto', scrollbarGutter: 'stable'/);
});

// 验证数据总线连接列表在面板缩小时仍能把超出内容留在内部滚动区。
test('数据总线连接列表支持面板收缩和内部滚动', () => {
  assert.match(dataBusSource, /import '\.\/index\.css'/);
  assert.match(dataBusSource, /className="data-bus-connection-card"/);
  assert.match(dataBusSource, /className="data-bus-connection-list"/);
  const card = dataBusRule('.data-bus-connection-card');
  assert.equal(card.height, '100%');
  assert.equal(card.display, 'flex');
  assert.equal(card['flex-direction'], 'column');
  assert.equal(card['min-height'], '0');
  assert.equal(card['min-width'], '0');
  const body = dataBusRule('.data-bus-connection-card > .ant-card-body');
  assert.equal(body.display, 'flex');
  assert.equal(body['flex-direction'], 'column');
  assert.equal(body.flex, '1 1 0');
  assert.equal(body['min-height'], '0');
  assert.equal(body['min-width'], '0');
  assert.equal(body.overflow, 'hidden');
  const list = dataBusRule('.data-bus-connection-list');
  assert.equal(list.flex.split(/\s+/)[1], '1', '连接列表必须允许收缩');
  assert.equal(list['min-height'], '100px', '连接列表保留可用高度，但不能被内容撑高');
  assert.equal(list.overflow, 'auto');
  assert.equal(list['scrollbar-gutter'], 'stable');
});

// 验证标签目录的收缩和滚动不依赖连接列表剩余内容高度。
test('数据总线标签目录保留独立的收缩和滚动链路', () => {
  assert.match(dataBusSource, /className="data-bus-tag-directory"/);
  assert.match(dataBusSource, /className="data-bus-tag-list"/);
  const directory = dataBusRule('.data-bus-tag-directory');
  assert.equal(directory.display, 'flex');
  assert.equal(directory['flex-direction'], 'column');
  assert.equal(directory.flex, '1 1 0');
  assert.equal(directory['min-height'], '0');
  const list = dataBusRule('.data-bus-tag-list');
  assert.equal(list.flex, '1 1 0');
  assert.equal(list['min-height'], '0');
  assert.equal(list.overflow, 'auto');
  assert.equal(list['scrollbar-gutter'], 'stable');
});
