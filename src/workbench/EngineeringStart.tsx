import { Button, Card, Space, Statistic, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useAppMode } from '../offline/app-mode-context';

const { Text, Title } = Typography;

export function EngineeringStart() {
  const navigate = useNavigate();
  const { mode, workspace, workspaceFilePath } = useAppMode();
  const offline = mode === 'offline';
  const config = workspace?.config;
  return (
    <section className="workbench-engineering-start" aria-label="工程配置入口">
      <div>
        <Title level={4}>{offline ? workspace?.workspace_name || '离线工作区' : '工程配置工作台'}</Title>
        <Text type="secondary">{offline
          ? `${workspaceFilePath ? '工作区已关联文件' : '工作区尚未另存为文件'} · 配置不会自动下发到设备`
          : '按接入、点表、路由、控制的顺序配置；在线保存的生效方式以各页面提示为准。'}</Text>
      </div>
      {offline && config ? <div className="workbench-start-counts">
        <Statistic title="协议连接" value={config.iec104.links.length + config.modbus_rtu.links.length + config.modbus_tcp.links.length + config.dlt645.links.length} />
        <Statistic title="控制组" value={config.agc.groups.length + config.avc.groups.length} />
        <Statistic title="数据路由" value={config.data_bus.routes.items.length} />
      </div> : null}
      <div className="workbench-start-grid">
        {[
          { title: '设备与点表', description: '选择协议连接，配置通信参数与点位', path: '/protocol/modbus-rtu', action: '进入协议接入' },
          { title: '数据关联', description: '核对来源、去向及点位路由', path: '/data-bus', action: '进入数据总线' },
          { title: '控制策略', description: '配置 AGC / AVC 与已有点位绑定', path: '/control', action: '进入控制策略' },
          { title: '工程文件', description: '管理配置导入、导出与交付文件', path: '/settings', action: '管理工程文件' },
        ].map(item => <Card key={item.path} size="small">
          <Space orientation="vertical" size={8}>
            <Text strong>{item.title}</Text><Text type="secondary">{item.description}</Text>
            <Button onClick={() => navigate(item.path)}>{item.action}</Button>
          </Space>
        </Card>)}
      </div>
    </section>
  );
}
