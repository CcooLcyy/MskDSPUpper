import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveLowerUpdateDownloadResult } from '../../src/utils/lower-update-deploy.ts';

const manifest = { platform: 'linux-arm64', channel: 'ci', version: '1', image_id: 'image-a', asset: { name: 'mskdsp-1', size: 10, sha256: 'ABC' } };
const result = { package_name: 'mskdsp-1', package_path: '/cache/package', downloaded_bytes: 10, sha256: 'abc' };

// 本地导入目标必须使用自己的包，后台最新下载不得替换它。
test('本地版本选择保留导入包且拒绝后台最新结果', () => {
  const local = { ...manifest, local_import: true };
  assert.equal(resolveLowerUpdateDownloadResult(local, result, manifest, { ...result, package_path: '/online' }), result);
  assert.equal(resolveLowerUpdateDownloadResult(local, null, manifest, result), null);
});

// 同通道的新构建也必须校验版本、摘要、名称和大小。
test('在线结果必须完整匹配当前所选包', () => {
  assert.equal(resolveLowerUpdateDownloadResult(manifest, null, manifest, result), result);
  for (const changed of [
    { ...manifest, version: '2' }, { ...manifest, platform: 'linux-x64' },
    { ...manifest, image_id: 'image-b' }, { ...manifest, channel: 'beta' },
    { ...manifest, asset: { ...manifest.asset, sha256: 'def' } },
  ]) assert.equal(resolveLowerUpdateDownloadResult(changed, null, manifest, result), null);
  for (const changed of [{ ...result, sha256: 'def' }, { ...result, downloaded_bytes: 9 }, { ...result, package_name: 'other' }]) {
    assert.equal(resolveLowerUpdateDownloadResult(manifest, changed, null, null), null);
  }
  assert.equal(resolveLowerUpdateDownloadResult(null, result, manifest, result), null);
});
