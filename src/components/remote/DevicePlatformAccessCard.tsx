import { useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, Button, Card, Checkbox, Descriptions, Drawer, Form, Input, InputNumber, Space, Switch, Tag, Typography } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { useCapability } from '../../offline/use-capability';
import { createPlatformAccessController, FACTORY_PLATFORM_TARGET, isOrdinaryNetworkPresetApplied, ordinaryNetworkPreset, type PlatformAccessRequest, type PlatformAccessStatus } from '../../utils/lower-platform-access';
import './DevicePlatformAccessCard.css';

const api = {
  read: () => invoke<PlatformAccessStatus>('get_lower_platform_access_config'),
  save: (request: PlatformAccessRequest) => invoke<PlatformAccessStatus>('set_lower_platform_access_config', { request }),
};

export default function DevicePlatformAccessCard({ connectionKey, ready }: { connectionKey: number; ready: boolean }) {
  const canRead = useCapability('module.ops');
  const canWrite = useCapability('runtime.control');
  const desktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [controller] = useState(() => createPlatformAccessController(api));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const { form, status } = state;
  const disabled = !desktop || !ready || !canRead || !canWrite || !status || state.loading || state.saving || state.needsReload;
  const connectionStatus = !status ? '未读取' : !status.enabled ? '未启用' : status.online ? '在线' : status.last_error ? '连接异常' : '正在连接';
  const connectionColor = status?.online ? 'green' : status?.enabled ? 'orange' : 'default';
  const networkSupported = Boolean(status?.network_config);
  const fixedNetwork = ordinaryNetworkPreset();
  const networkApplied = isOrdinaryNetworkPresetApplied(status);

  useEffect(() => {
    controller.reset();
    if (!desktop || !ready || !canRead) return;
    void controller.read();
    const timer = window.setInterval(() => { void controller.refreshRuntime(); }, 3000);
    return () => { window.clearInterval(timer); controller.reset(); };
  }, [controller, desktop, ready, canRead, connectionKey]);

  const openConfiguration = () => {
    console.info('[模块运维] 打开设备平台接入配置抽屉');
    setDrawerOpen(true);
  };

  return <>
    <Card size="small" className="device-platform-access-summary">
      <div className="device-platform-access-summary-row">
        <Space size={8} wrap>
          <Typography.Text strong>平台接入</Typography.Text>
          <Typography.Text type="secondary">{status ? status.enabled ? '已启用' : '已停用' : '启用状态未读取'}</Typography.Text>
          <Tag color={connectionColor}>{connectionStatus}</Tag>
        </Space>
        <Button icon={<SettingOutlined />} onClick={openConfiguration}>平台配置</Button>
      </div>
      {(state.error || status?.last_error) && <Typography.Paragraph
        className="device-platform-access-summary-error"
        type={state.error ? 'danger' : 'warning'}
        ellipsis={{ rows: 1, tooltip: true }}
      >{state.error ? `配置操作：${state.error}` : `平台连接：${status?.last_error}`}</Typography.Paragraph>}
    </Card>
    <Drawer
      title="设备平台接入配置"
      open={drawerOpen}
      onClose={() => setDrawerOpen(false)}
      size={624}
      rootClassName="device-platform-access-drawer"
      destroyOnHidden={false}
      footer={<div className="device-platform-access-footer">
        <Typography.Text type="secondary">配置保存在下位机，保存后立即生效。</Typography.Text>
        <Space wrap>
          <Button loading={state.loading} disabled={!desktop || !ready || !canRead || state.saving} onClick={() => void controller.read()}>重新读取</Button>
          <Button type="primary" loading={state.saving} disabled={disabled} onClick={() => void controller.save()}>保存并应用</Button>
        </Space>
      </div>}
    >
      <Typography.Paragraph type="secondary">
        出厂前通过现场直连保存。配置在断电、重启及软件升级后自动保留，下位机会重新接入平台，无需重建容器。
      </Typography.Paragraph>
      {!desktop || !canRead ? <Alert type="info" title="请在桌面上位机的在线直连模式配置设备平台接入" showIcon /> : <>
        <Descriptions size="small" column={1} className="device-platform-access-details">
          <Descriptions.Item label="平台地址">{FACTORY_PLATFORM_TARGET}</Descriptions.Item>
          <Descriptions.Item label="当前现场设备">{status?.manager_address ?? '请先连接并读取配置'}</Descriptions.Item>
          <Descriptions.Item label="平台连接状态"><Tag color={connectionColor}>{connectionStatus}</Tag></Descriptions.Item>
          <Descriptions.Item label="已有设备令牌">{status ? status.token_configured ? '已配置（不显示明文）' : '未配置' : '未读取'}</Descriptions.Item>
        </Descriptions>
        <div className="device-platform-access-messages">
          {state.error && <Alert type="error" title={state.error} showIcon />}
          {state.saved && <Alert type="success" title="配置已持久保存并应用" description="平台连接状态会持续刷新，是否连接成功请以当前状态为准。" showIcon />}
          {status?.last_error && <Alert type="warning" title="平台连接异常" description={status.last_error} showIcon />}
          {status?.network_error && <Alert type="error" title="普通外网出口异常" description={status.network_error} showIcon />}
        </div>
        <Form layout="vertical" className="device-platform-access-form">
          <Form.Item label="启用平台接入">
            <Switch checked={form.enabled} disabled={disabled} onChange={enabled => controller.update({ enabled })} aria-label="启用设备平台接入" />
          </Form.Item>
          <Form.Item label="设备 ID" htmlFor="platform-access-device-id">
            <Input id="platform-access-device-id" value={form.device_id} disabled={disabled} maxLength={128} placeholder="平台分配的设备 ID" aria-label="平台设备 ID"
              onChange={event => controller.update({ device_id: event.target.value })} />
          </Form.Item>
          <Form.Item label="新设备令牌" htmlFor="platform-access-device-token" extra="留空保留已有令牌；更换设备 ID 时需提供新令牌，或关闭接入后清除旧令牌。">
            <Input.Password id="platform-access-device-token" value={form.device_token} disabled={disabled || form.clear_device_token} maxLength={4096} autoComplete="new-password"
              placeholder={status?.token_configured ? '留空保留已有令牌' : '输入平台分配的设备令牌'} aria-label="新设备令牌"
              onChange={event => controller.update({ device_token: event.target.value })} />
          </Form.Item>
          <Form.Item>
            <Checkbox checked={form.clear_device_token} disabled={disabled || !status?.token_configured}
              onChange={event => controller.update({ clear_device_token: event.target.checked, ...(event.target.checked ? { device_token: '' } : {}) })}>
              显式清除已有设备令牌（需先关闭平台接入）
            </Checkbox>
          </Form.Item>
          <Typography.Title level={5} className="device-platform-access-section-title">设备普通外网出口</Typography.Title>
          <Typography.Paragraph type="secondary">
            影响整个设备的普通 IPv4 外网流量；关闭平台接入后仍有效。纵密业务网络由纵密页面独立维护。
          </Typography.Paragraph>
          {status && !networkSupported && <Alert className="device-platform-access-network-notice" type="info" showIcon
            title="当前下位机不支持普通外网出口配置，请升级下位机。已有平台设置仍可保存。" />}
          <Descriptions size="small" column={1} className="device-platform-access-network-status">
            <Descriptions.Item label="固定出口网口">102 口（{fixedNetwork.interface_name}）</Descriptions.Item>
            <Descriptions.Item label="固定 IPv4 网关">{fixedNetwork.gateway}</Descriptions.Item>
            <Descriptions.Item label="DNS">沿用设备已有 DNS</Descriptions.Item>
            <Descriptions.Item label="固定出口状态">{!status ? '未读取' : !networkSupported ? '当前下位机不支持' : networkApplied ? '已应用' : '待应用'}</Descriptions.Item>
            <Descriptions.Item label="设备当前源地址">{status?.network_source_address || '--'}</Descriptions.Item>
          </Descriptions>
          <Typography.Paragraph type="secondary">点击下方“保存并应用”时自动应用固定出口。已应用表示出口配置完成，外网是否可达仍需联调验证。</Typography.Paragraph>
          <Typography.Title level={5} className="device-platform-access-section-title">远程 SSH</Typography.Title>
          <Form.Item label="允许远程 SSH">
            <Switch checked={form.ssh_enabled} disabled={disabled} onChange={ssh_enabled => controller.update({ ssh_enabled })} aria-label="允许远程 SSH" />
          </Form.Item>
          <Form.Item label="本机 SSH 端口" htmlFor="platform-access-ssh-port">
            <InputNumber id="platform-access-ssh-port" value={form.ssh_port || null} min={1} max={65535} precision={0} disabled={disabled || !form.ssh_enabled} placeholder="默认 22"
              aria-label="下位机本机 SSH 端口" onChange={port => controller.update({ ssh_port: port ?? 0 })} />
          </Form.Item>
        </Form>
      </>}
    </Drawer>
  </>;
}
