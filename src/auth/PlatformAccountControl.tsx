import { App, Badge, Button, Space, Tag, Tooltip, Typography } from 'antd';
import { LogoutOutlined } from '@ant-design/icons';
import { usePlatformAuth } from './platform-auth-context.ts';

export function PlatformAccountControl() {
  const { snapshot, controller } = usePlatformAuth();
  const { modal, message } = App.useApp();
  const status = snapshot.phase === 'authenticated' ? snapshot.status : null;
  const online = status?.connection_state === 'online';
  if (!status?.authenticated) return null;
  return (
    <Space size={8} style={{ flexShrink: 0 }}>
      <Tooltip title={status?.message || (online ? '平台在线' : '平台正在重连，会话到期前可继续本地配置')}>
        <Badge status={online ? 'success' : 'warning'} text={<Typography.Text style={{ fontSize: 13 }}>平台{online ? '在线' : '重连中'} · {status?.display_name || status?.username || '平台账号'}</Typography.Text>} />
      </Tooltip>
      {status.role && <Tag style={{ marginInlineEnd: 0 }}>{status.role === 'admin' ? '管理员' : '运维人员'}</Tag>}
      <Button size="small" type="text" icon={<LogoutOutlined />} onClick={() => {
        modal.confirm({
          title: '退出平台账号？',
          content: '请先保存当前页面和工作区中的修改。退出后将清理工作台，未保存的内容会丢失，并返回登录页，可直接使用其他账号登录。',
          okText: '退出登录', cancelText: '返回保存',
          onOk: async () => {
            if (!await controller.logout()) void message.error(controller.getSnapshot().error || '退出登录未完成，请稍后重试。');
          },
        });
      }}>退出</Button>
    </Space>
  );
}
