// 回归 Node #64061/#64706：内部报告帧与中文标准输出合并读取不能破坏测试结果。
import { writeSync } from 'node:fs';
import test from 'node:test';
import { serialize } from 'node:v8';

test('中文标准输出与测试消息共存', () => {});
const payload = serialize({
  type: 'test:diagnostic',
  data: { nesting: 0, message: '运行环境消息边界探针', file: import.meta.filename },
});
const length = Buffer.alloc(4);
length.writeUInt32BE(payload.length);
const frame = Buffer.concat([Buffer.from([255, 15]), length, payload]);
writeSync(1, Buffer.concat([frame, Buffer.from('\n中文日志保持原样输出\n', 'utf8')]));
