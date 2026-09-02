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
const agcSource = readFileSync(new URL('../../src/pages/AGC/index.tsx', import.meta.url), 'utf8');
const avcSource = readFileSync(new URL('../../src/pages/AVC/index.tsx', import.meta.url), 'utf8');

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
  for (const source of [agcSource, avcSource]) {
    assert.match(source, /minHeight: 0, flex: '1 1 auto', display: 'flex', flexDirection: 'column', overflow: 'hidden'/);
    assert.match(source, /body: \{ flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden'/);
    assert.match(source, /minHeight: 0, overflowY: 'auto', scrollbarGutter: 'stable'/);
  }
});

// 验证数据总线连接列表在面板缩小时仍能把超出内容留在内部滚动区。
test('数据总线连接列表支持面板收缩和内部滚动', () => {
  assert.match(dataBusSource, /flex: '1 1 0', minHeight: 0, minWidth: 0, overflowY: 'auto', scrollbarGutter: 'stable'/);
});
