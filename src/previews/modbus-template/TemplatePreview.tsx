import { useState } from 'react';
import { App, Badge, Button, Input, Layout, Menu, Modal, Space, Tag, Typography } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ModbusPoint } from '../../adapters/types';
import PointTable from '../../pages/ModbusRTU/components/PointTable';
import TemplateModal from '../../features/modbus-templates/TemplateModal';
import '../../components/protocol/protocol-page.css';

type Connection = { id: number; name: string; protocol: 'RTU' | 'TCP'; points: ModbusPoint[] };
const initialConnections: Connection[] = [{ id: 1, name: 'ceshi', protocol: 'RTU', points: [] }];
const { Text } = Typography;

/** 正式组件的独立试用入口：连接点表只在内存，模板库使用真实内置与个人模板。 */
export default function TemplatePreview() {
  const { message, modal } = App.useApp();
  const [connections, setConnections] = useState(initialConnections);
  const [connectionId, setConnectionId] = useState(1);
  const [protocol, setProtocol] = useState<'RTU' | 'TCP'>('RTU');
  const [templateOpen, setTemplateOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [tag, setTag] = useState('');
  const connection = connections.find((item) => item.id === connectionId && item.protocol === protocol);
  const points = connection?.points ?? [];
  const updatePoints = (next: ModbusPoint[]) => setConnections((items) => items.map((item) => item.id === connectionId ? { ...item, points: next } : item));
  return <Layout className="template-preview">
    <Layout.Sider width={200} className="preview-sidebar"><div className="preview-brand">MskDSP 控制台</div>
      <Menu mode="inline" theme="dark" selectedKeys={[protocol]} items={[{ key: 'RTU', label: 'Modbus RTU' }, { key: 'TCP', label: 'Modbus TCP' }]}
        onClick={({ key }) => { const next = key as 'RTU' | 'TCP'; setProtocol(next); setConnectionId(connections.find((item) => item.protocol === next)?.id ?? -1); }} />
      <div className="preview-side-note">正式模板库 · 独立试用</div>
    </Layout.Sider>
    <Layout><Layout.Header className="preview-header"><Text strong>连接配置 · Modbus {protocol}</Text><Space><Tag color="blue">正式组件试用</Tag>
      <Button size="small" icon={<ReloadOutlined />} onClick={() => modal.confirm({ title: '重置试用连接？', content: '清空本页试用连接和点位，个人模板仍保留。', okText: '重置', cancelText: '取消', onOk: () => { setConnections(initialConnections); setProtocol('RTU'); setConnectionId(1); } })}>重置连接</Button></Space></Layout.Header>
      <Layout.Content className="preview-content"><div className="preview-top"><section className="preview-connections"><div className="preview-section-title">连接列表</div>
        <div className="preview-connection-scroll">{connections.filter((item) => item.protocol === protocol).map((item) => <button key={item.id} className={'preview-connection' + (connectionId === item.id ? ' selected' : '')} onClick={() => setConnectionId(item.id)}>
          <Badge color="#f44336" /><span><strong>{item.name}</strong><small>已停止 · {item.points.length} 个点位</small></span></button>)}</div>
        <Button type="primary" block icon={<PlusOutlined />} onClick={() => { setName('连接' + (connections.length + 1)); setCreateOpen(true); }}>新增连接</Button></section>
        <section className="preview-status"><Space><Text strong>{connection?.name ?? '未选择连接'}</Text><Tag>已停止</Tag><Text type="secondary">从站 1 · 0 基（协议偏移）</Text></Space>
          <p style={{ color: '#aaa', marginTop: 20 }}>这里使用与正式 RTU/TCP 页面相同的模板组件和 PDF 点表。试用连接不会访问设备，刷新后恢复为空点表。</p>
          <p style={{ color: '#aaa', marginTop: 10 }}>导入或保存的个人模板会保留；选择前请核对型号、协议版本和适用说明。</p></section></div>
        <PointTable points={points} selectedConn={connection?.name ?? null} addressBase={1} actionsDisabled={templateOpen}
          realtimeByTag={{}} realtimeRevisionByTag={{}} realtimeLoading={false} pointsLoading={false} readPlan={null} readPlanSaving={false}
          runtimeRunning={false} showReadPlan={false} onReadPlanSave={async () => true} onApplyTemplate={() => setTemplateOpen(true)}
          onAdd={() => {
            const address = Math.max(0, ...points.map((point) => point.address + point.reg_count));
            let newTag = '手动点位' + address; while (points.some((point) => point.tag === newTag)) newTag += '_2';
            updatePoints([...points, { tag: newTag, address, function: 2, data_type: 2, reg_count: 1, scale: 1, scale_decimal: '1', offset: 0, offset_decimal: '0', deadband: 0, deadband_decimal: '0', word_order: 1, byte_order: 1, bit_index: null }]);
          }}
          onEdit={(index) => { setEditingIndex(index); setTag(points[index].tag); }}
          onCopy={(index) => { const copy = points[index]; const address = Math.max(0, ...points.map((point) => point.address + point.reg_count)); let copyTag = copy.tag + '_副本'; while (points.some((point) => point.tag === copyTag)) copyTag += '_2'; updatePoints([...points, { ...copy, tag: copyTag, address }]); }}
          onDelete={(index) => updatePoints(points.filter((_, position) => position !== index))} onDeleteAll={() => updatePoints([])} />
      </Layout.Content>
    </Layout>
    {connection && <TemplateModal key={connection.id} open={templateOpen} protocol={protocol} addressBase={1} connectionName={connection.name} existingPoints={points} busy={false}
      onClose={() => setTemplateOpen(false)} onApply={async (additions) => { updatePoints([...points, ...additions]); void message.success('已添加 ' + additions.length + ' 个点位到试用连接'); return true; }} />}
    <Modal title={'新增 Modbus ' + protocol + ' 试用连接'} open={createOpen} onCancel={() => setCreateOpen(false)} okText="创建空连接" cancelText="取消" onOk={() => {
      if (!name.trim() || connections.some((item) => item.name === name.trim())) { void message.error('连接名称不能为空或重复'); return; }
      const id = Math.max(0, ...connections.map((item) => item.id)) + 1;
      setConnections([...connections, { id, name: name.trim(), protocol, points: [] }]); setConnectionId(id); setCreateOpen(false);
    }}><Input aria-label="连接名称" value={name} onChange={(event) => setName(event.target.value)} /></Modal>
    <Modal title="编辑试用点位标签" open={editingIndex !== null} onCancel={() => setEditingIndex(null)} okText="保存" cancelText="取消" onOk={() => {
      if (!tag.trim() || points.some((point, index) => index !== editingIndex && point.tag === tag.trim())) { void message.error('标签不能为空或重复'); return; }
      updatePoints(points.map((point, index) => index === editingIndex ? { ...point, tag: tag.trim() } : point)); setEditingIndex(null);
    }}><Input aria-label="点位标签" value={tag} onChange={(event) => setTag(event.target.value)} /></Modal>
  </Layout>;
}