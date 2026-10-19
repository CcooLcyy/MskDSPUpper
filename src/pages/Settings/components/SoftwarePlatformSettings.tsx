import { useEffect, useState } from 'react';
import { Button, Card, Input, Space, Typography, message } from 'antd';
import { api } from '../../../adapters';
import { saveAppSetting } from '../../../utils/app-settings';
import {
  DEFAULT_SOFTWARE_PLATFORM_ENDPOINT,
  SOFTWARE_PLATFORM_ENDPOINT_KEY,
  normalizeSoftwarePlatformEndpoint,
} from '../../../utils/software-platform';

export default function SoftwarePlatformSettings() {
  const [endpoint, setEndpoint] = useState(DEFAULT_SOFTWARE_PLATFORM_ENDPOINT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    let active = true;
    void api.loadAppSettings().then((settings) => {
      const saved = settings[SOFTWARE_PLATFORM_ENDPOINT_KEY];
      if (active && typeof saved === 'string' && saved.trim()) setEndpoint(saved);
    }).catch((error) => {
      if (active) messageApi.error(`读取软件平台地址失败：${String(error)}`);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [messageApi]);

  async function save() {
    setSaving(true);
    try {
      const normalized = normalizeSoftwarePlatformEndpoint(endpoint);
      await saveAppSetting(SOFTWARE_PLATFORM_ENDPOINT_KEY, normalized);
      setEndpoint(normalized);
      messageApi.success('软件平台地址已保存，下次检查更新时生效');
    } catch (error) {
      messageApi.error(`保存软件平台地址失败：${String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return <Card title="软件平台" size="small" bordered>
    {contextHolder}
    <Typography.Paragraph type="secondary">
      上位机和下位机安装包均从此平台获取。保存后，下次检查更新时生效。
    </Typography.Paragraph>
    <Space.Compact style={{ width: '100%', maxWidth: 720 }}>
      <Input aria-label="平台 gRPC 地址" value={endpoint} disabled={loading || saving}
        placeholder={DEFAULT_SOFTWARE_PLATFORM_ENDPOINT} onChange={(event) => setEndpoint(event.target.value)}
        onPressEnter={() => { if (!loading && !saving) void save(); }} />
      <Button type="primary" loading={saving} disabled={loading} onClick={() => void save()}>保存平台地址</Button>
    </Space.Compact>
  </Card>;
}
