import { App, Badge, Button, Space, Tooltip, Typography } from 'antd';
import { LogoutOutlined } from '@ant-design/icons';
import { usePlatformAuth } from './platform-auth-context.ts';

export function PlatformAccountControl() {
  const { snapshot, controller } = usePlatformAuth();
  const { modal } = App.useApp();
  const status = snapshot.status;
  const online = status?.connection_state === 'online';
  return (
    <Space size={8} style={{ flexShrink: 0 }}>
      <Tooltip title={status?.message || (online ? '平台在线' : '平台正在重连，会话到期前可继续本地配置')}>
        <Badge status={online ? 'success' : 'warning'} text={<Typography.Text style={{ fontSize: 13 }}>{status?.display_name || status?.username || '平台账号'}</Typography.Text>} />
      </Tooltip>
      <Button size="small" type="text" icon={<LogoutOutlined />} onClick={() => {
        modal.confirm({
          title: '退出平台账号？',
          content: '请先保存当前页面和工作区中的修改。退出后工作台将锁定，本次运行中的页面草稿保留，使用原账号重新登录可继续；关闭程序可能丢失未保存内容。',
          okText: '退出并锁定', cancelText: '返回保存',
          onOk: () => controller.logout(),
        });
      }}>退出</Button>
    </Space>
  );
}
