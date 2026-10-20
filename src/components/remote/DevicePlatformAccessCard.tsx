import { useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, Button, Card, Checkbox, Descriptions, Input, InputNumber, Space, Switch, Tag, Typography } from 'antd';
import { invoke } from '@tauri-apps/api/core';
import { useCapability } from '../../offline/use-capability';
import { createPlatformAccessController, FACTORY_PLATFORM_TARGET, type PlatformAccessRequest, type PlatformAccessStatus } from '../../utils/lower-platform-access';

const api = {
  read: () => invoke<PlatformAccessStatus>('get_lower_platform_access_config'),
  save: (request: PlatformAccessRequest) => invoke<PlatformAccessStatus>('set_lower_platform_access_config', { request }),
};

export default function DevicePlatformAccessCard({ connectionKey, ready }: { connectionKey: number; ready: boolean }) {
  const canRead = useCapability('module.ops');
  const canWrite = useCapability('runtime.control');
  const desktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const [controller] = useState(() => createPlatformAccessController(api));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const { form, status } = state;
  const disabled = !desktop || !ready || !canRead || !canWrite || !status || state.loading || state.saving || state.needsReload;

  useEffect(() => {
    controller.reset();
    if (!desktop || !ready || !canRead) return;
    void controller.read();
    const timer = window.setInterval(() => { void controller.refreshRuntime(); }, 3000);
    return () => { window.clearInterval(timer); controller.reset(); };
  }, [controller, desktop, ready, canRead, connectionKey]);

  return <Card title="设备平台接入配置" size="small" style={{ marginTop: 12, marginBottom: 12, minHeight: 220, maxHeight: '55vh', overflowY: 'auto' }}>
    <Typography.Paragraph type="secondary">
      出厂前通过现场直连保存。配置保存在下位机，断电、重启及软件升级后自动保留并重新接入平台；保存立即生效，无需重建容器。
    </Typography.Paragraph>
    {!desktop || !canRead ? <Alert type="info" title="请在桌面上位机的在线直连模式配置设备平台接入" /> : <>
      <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
        <Descriptions.Item label="平台地址">{FACTORY_PLATFORM_TARGET}</Descriptions.Item>
        <Descriptions.Item label="当前现场设备">{status?.manager_address ?? '请先连接并读取配置'}</Descriptions.Item>
        <Descriptions.Item label="设备连接状态">
          <Tag color={status?.online ? 'green' : status?.enabled ? 'orange' : 'default'}>
            {!status ? '未读取' : !status.enabled ? '未启用' : status.online ? '在线' : status.last_error ? '连接异常' : '正在连接'}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="已有设备令牌">{status ? status.token_configured ? '已配置（不显示明文）' : '未配置' : '未读取'}</Descriptions.Item>
      </Descriptions>
      {state.error && <Alert type="error" title={state.error} showIcon style={{ marginBottom: 12 }} />}
      {status?.last_error && <Alert type="warning" title={`下位机状态：${status.last_error}`} showIcon style={{ marginBottom: 12 }} />}
      {state.saved && <Alert type="success" title="配置已持久保存并热应用；尚未在线时，下位机会自动重试连接" showIcon style={{ marginBottom: 12 }} />}
      <Space wrap align="start" style={{ marginBottom: 12 }}>
        <Space direction="vertical" size={4}>
          <Typography.Text>启用平台接入</Typography.Text>
          <Switch checked={form.enabled} disabled={disabled} onChange={enabled => controller.update({ enabled })} aria-label="启用设备平台接入" />
        </Space>
        <Space direction="vertical" size={4}>
          <Typography.Text>设备 ID</Typography.Text>
          <Input value={form.device_id} disabled={disabled} maxLength={128} placeholder="平台分配的设备 ID" aria-label="平台设备 ID"
            onChange={event => controller.update({ device_id: event.target.value })} style={{ width: 250 }} />
        </Space>
        <Space direction="vertical" size={4}>
          <Typography.Text>新设备令牌</Typography.Text>
          <Input.Password value={form.device_token} disabled={disabled || form.clear_device_token} maxLength={4096} autoComplete="new-password"
            placeholder={status?.token_configured ? '留空保留已有令牌' : '输入平台分配的设备令牌'} aria-label="新设备令牌"
            onChange={event => controller.update({ device_token: event.target.value })} style={{ width: 280 }} />
        </Space>
        <Space direction="vertical" size={4}>
          <Typography.Text>允许 SSH</Typography.Text>
          <Switch checked={form.ssh_enabled} disabled={disabled} onChange={ssh_enabled => controller.update({ ssh_enabled })} aria-label="允许远程 SSH" />
        </Space>
        <Space direction="vertical" size={4}>
          <Typography.Text>本机 SSH 端口</Typography.Text>
          <InputNumber value={form.ssh_port || null} min={1} max={65535} precision={0} disabled={disabled || !form.ssh_enabled} placeholder="默认 22"
            aria-label="下位机本机 SSH 端口" onChange={port => controller.update({ ssh_port: port ?? 0 })} />
        </Space>
      </Space>
      <div style={{ marginBottom: 12 }}>
        <Checkbox checked={form.clear_device_token} disabled={disabled || !status?.token_configured}
          onChange={event => controller.update({ clear_device_token: event.target.checked, ...(event.target.checked ? { device_token: '' } : {}) })}>
          显式清除已有设备令牌（需先关闭平台接入）
        </Checkbox>
      </div>
      <Space wrap>
        <Button loading={state.loading} disabled={!ready || !canRead || state.saving} onClick={() => void controller.read()}>重新读取配置</Button>
        <Button type="primary" loading={state.saving} disabled={disabled} onClick={() => void controller.save()}>保存并立即应用</Button>
        <Typography.Text type="secondary">空令牌输入保留已有值；更换设备 ID 时需提供新令牌或关闭后清除旧令牌。</Typography.Text>
      </Space>
    </>}
  </Card>;
}
