import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Checkbox, Empty, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { DeleteOutlined, DownloadOutlined, FolderOpenOutlined, SaveOutlined, SearchOutlined, UploadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { ModbusPoint } from '../../adapters/types';
import {
  createTemplateFromPoints, isTemplateWritePoint, planTemplateApplication,
} from './model';
import type { ModbusTemplate, TemplateApplicationRow } from './model';
import {
  importPersonalTemplate, listModbusTemplates, removePersonalTemplate,
  saveModbusTemplateFile, savePersonalTemplate,
} from './catalog';
import type { TemplateCatalogEntry } from './catalog';
import './templates.css';

interface Props {
  open: boolean;
  connectionName: string;
  protocol: 'RTU' | 'TCP';
  addressBase: number;
  existingPoints: ModbusPoint[];
  busy: boolean;
  onClose: () => void;
  onApply: (points: ModbusPoint[]) => Promise<boolean>;
}

const { Text, Title } = Typography;
const functionLabels: Record<number, string> = { 1: '0x01', 3: '0x03', 4: '0x04', 5: '0x05', 6: '0x06', 16: '0x10' };
const initialSelection = (template: ModbusTemplate): string[] => template.points
  .filter((point) => !isTemplateWritePoint(point) && point.default_selected !== false).map((point) => point.id);

/** RTU/TCP 共用的模板预览和个人模板管理，保存点表由所属协议页面负责。 */
export default function TemplateModal({ open, connectionName, protocol, addressBase, existingPoints, busy, onClose, onApply }: Props) {
  const { message, modal } = App.useApp();
  const [entries, setEntries] = useState<TemplateCatalogEntry[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [templateSearch, setTemplateSearch] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [pointSearch, setPointSearch] = useState('');
  const [group, setGroup] = useState('');
  const [prefix, setPrefix] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveForm] = Form.useForm<{ name: string; manufacturer: string; model: string }>();
  const [tableArea, setTableArea] = useState<HTMLDivElement | null>(null);
  const [tableHeight, setTableHeight] = useState(180);
  const disabled = busy || working;
  const filteredEntries = entries.filter(({ template }) =>
    (!manufacturer || template.manufacturer === manufacturer)
    && `${template.name} ${template.manufacturer} ${template.models.join(' ')} ${template.protocol_version}`
      .toLowerCase().includes(templateSearch.toLowerCase()),
  );
  // 筛选变化时只展示筛选结果中的模板，不保留隐藏的旧模板供提交。
  const entry = filteredEntries.find(({ template }) => template.id === selectedTemplateId) ?? filteredEntries[0];
  const template = entry?.template;
  const currentSelection = useMemo(() => template?.id === selectedTemplateId
    ? selectedIds : template ? initialSelection(template) : [], [template, selectedTemplateId, selectedIds]);
  const plan = useMemo(() => template
    ? planTemplateApplication(template, { existingPoints, addressBase, prefix, selectedIds: currentSelection })
    : { rows: [], points: [] }, [template, existingPoints, addressBase, prefix, currentSelection]);
  const visibleRows = plan.rows.filter((row) => (!group || row.source.group === group)
    && `${row.finalTag} ${row.source.address} ${row.point.address}`.toLowerCase().includes(pointSearch.toLowerCase()));
  const selectedRows = plan.rows.filter((row) => row.selected);
  const skipped = selectedRows.filter((row) => row.conflict).length;
  const writes = plan.points.filter((point) => [4, 5, 6].includes(point.function)).length;
  const conditionCount = selectedRows.filter((row) => row.source.condition && !row.conflict).length;

  useEffect(() => {
    if (!open) return;
    try {
      const list = listModbusTemplates();
      setEntries(list); setError(null);
      const first = list[0]?.template;
      setSelectedTemplateId(first?.id ?? ''); setSelectedIds(first ? initialSelection(first) : []);
      setTemplateSearch(''); setManufacturer(''); setPointSearch(''); setGroup(''); setPrefix('');
    } catch (cause) { setEntries([]); setError(`读取模板失败：${String(cause)}`); }
  }, [open]);

  useLayoutEffect(() => {
    if (!tableArea) return;
    const measure = () => {
      const headerHeight = tableArea.querySelector<HTMLElement>('.ant-table-header')?.offsetHeight ?? 40;
      setTableHeight(Math.max(0, Math.floor(tableArea.clientHeight - headerHeight - 10)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(tableArea); measure();
    return () => observer.disconnect();
  }, [tableArea]);

  const choose = (next: ModbusTemplate) => {
    setSelectedTemplateId(next.id); setSelectedIds(initialSelection(next));
    setPointSearch(''); setGroup('');
  };
  const selectRows = (ids: string[]) => {
    if (template) setSelectedTemplateId(template.id);
    setSelectedIds(ids);
  };
  const reloadCatalog = (selectedId?: string) => {
    const list = listModbusTemplates(); setEntries(list);
    const next = list.find(({ template: item }) => item.id === selectedId)?.template ?? list[0]?.template;
    if (next) choose(next); else { setSelectedTemplateId(''); setSelectedIds([]); }
  };
  const importFile = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) { void message.error('模板文件不能超过 2 MiB'); return; }
    setWorking(true);
    try {
      const imported = await importPersonalTemplate(await file.text());
      setManufacturer(''); setTemplateSearch(''); reloadCatalog(imported.id);
      void message.success(`已导入模板“${imported.name}”`);
    } catch (cause) { void message.error(`导入模板失败：${String(cause)}`); }
    finally { setWorking(false); }
  };
  const exportFile = async () => {
    if (!template) return;
    setWorking(true);
    try { if (await saveModbusTemplateFile(template)) void message.success('模板已导出'); }
    catch (cause) { void message.error(`导出模板失败：${String(cause)}`); }
    finally { setWorking(false); }
  };
  const saveCurrent = async () => {
    const values = await saveForm.validateFields().catch(() => null);
    if (!values) return;
    setWorking(true);
    try {
      const personal = createTemplateFromPoints({
        id: `personal-${crypto.randomUUID()}`, name: values.name.trim(), manufacturer: values.manufacturer?.trim() || '自定义',
        models: values.model?.trim() ? [values.model.trim()] : [], protocolVersion: '个人模板', addressBase, points: existingPoints,
      });
      await savePersonalTemplate(personal); setSaveOpen(false); setManufacturer(''); setTemplateSearch(''); reloadCatalog(personal.id);
      void message.success('当前点表已保存为个人模板');
    } catch (cause) { void message.error(`保存模板失败：${String(cause)}`); }
    finally { setWorking(false); }
  };
  const removeCurrent = async () => {
    if (entry?.origin !== 'personal' || !template) return;
    setWorking(true);
    try { await removePersonalTemplate(template.id); reloadCatalog(); void message.success('个人模板已删除'); }
    catch (cause) { void message.error(`删除模板失败：${String(cause)}`); }
    finally { setWorking(false); }
  };
  const apply = async () => {
    if (!plan.points.length || disabled) return;
    const perform = async () => {
      setWorking(true);
      try {
        if (await onApply(plan.points)) {
          console.info('Modbus 点表模板已应用', { templateId: template?.id, connection: connectionName, added: plan.points.length, skipped });
          onClose();
        }
      } catch (cause) { console.error('Modbus 模板应用失败', cause); void message.error(`应用模板失败：${String(cause)}`); }
      finally { setWorking(false); }
    };
    if (writes || conditionCount) {
      modal.confirm({ title: '确认所选点位的适用条件',
        content: `本次包含 ${writes} 个写控制点、${conditionCount} 个有适用条件的点位。请核对型号、选配和模板说明；添加点位不会立即执行写控制。`,
        okText: '确认并添加', cancelText: '返回核对', onOk: perform,
      });
    } else await perform();
  };

  const columns: ColumnsType<TemplateApplicationRow> = [
    { title: '应用后的标签', dataIndex: 'finalTag', width: 200, render: (value, row) => <Tooltip title={row.source.description || undefined}>{value}</Tooltip> },
    { title: '分组', width: 120, render: (_, row) => row.source.group },
    { title: '功能码', width: 85, render: (_, row) => <Text type={isTemplateWritePoint(row.source) ? 'warning' : undefined}>{functionLabels[row.source.function_code]}</Text> },
    { title: '地址', width: 90, render: (_, row) => <Tooltip title={`模板地址 ${row.source.address}，${template?.address_base === 0 ? '0' : '1'} 基`}>{row.point.address}</Tooltip> },
    { title: '类型 / 寄存器数', width: 145, render: (_, row) => `${row.source.data_type} / ${row.point.reg_count}${row.point.bit_index === null ? '' : ` · 位${row.point.bit_index}`}` },
    { title: '倍率', width: 85, render: (_, row) => row.source.scale },
    { title: '单位', width: 70, render: (_, row) => row.source.unit || '—' },
    { title: '状态 / 条件', width: 165, render: (_, row) => row.conflict ? <Tooltip title={row.conflict}><Tag color="orange">冲突，跳过</Tag></Tooltip>
      : row.source.condition ? <Tooltip title={row.source.condition}><Tag color="gold">需核对适用条件</Tag></Tooltip>
        : <Text type="secondary">{isTemplateWritePoint(row.source) ? '写控制点' : '可添加'}</Text> },
  ];

  return <>
    <Modal title="应用点表模板" open={open} onCancel={() => { if (!disabled) onClose(); }} closable={!disabled} mask={{ closable: !disabled }}
      width="min(1380px, calc(100vw - 40px))" centered className="modbus-template-modal"
      styles={{ container: { height: 'min(900px, calc(100dvh - 40px))', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
        header: { flexShrink: 0 }, body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }, footer: { flexShrink: 0 } }}
      footer={<div className="mt-footer"><Space wrap><Text>已选 <strong>{selectedRows.length}</strong> 个点位</Text><Text type="secondary">可添加 {plan.points.length} 个{skipped ? ` · 冲突跳过 ${skipped} 个` : ''}</Text></Space>
        <Space><Button disabled={disabled} onClick={onClose}>取消</Button><Button type="primary" loading={disabled} disabled={!plan.points.length || !!error} onClick={() => void apply()}>添加 {plan.points.length} 个点位</Button></Space></div>}>
      <div className="mt-intro"><Text type="secondary">目标连接：<Text strong>{connectionName}</Text> · Modbus {protocol} · {addressBase === 2 ? '1' : '0'} 基</Text>
        <Space wrap><Tag>仅添加，不覆盖已有点位</Tag>
          <label className={`mt-import ${disabled ? 'disabled' : ''}`}><UploadOutlined /> 导入模板<input type="file" accept=".json,application/json" disabled={disabled} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }} /></label>
          <Button size="small" icon={<SaveOutlined />} disabled={disabled || !existingPoints.length} onClick={() => { saveForm.setFieldsValue({ name: `${connectionName}点表`, manufacturer: '', model: '' }); setSaveOpen(true); }}>保存当前点表为模板</Button>
        </Space></div>
      {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} />}
      <div className="mt-layout">
        <aside className="mt-picker">
          <Input prefix={<SearchOutlined />} aria-label="搜索模板" placeholder="搜索厂家、型号或版本" value={templateSearch} allowClear disabled={disabled} onChange={(event) => { setTemplateSearch(event.target.value); setGroup(''); setPointSearch(''); }} />
          <Select aria-label="厂家筛选" placeholder="全部厂家" value={manufacturer || undefined} allowClear disabled={disabled} onChange={(value) => { setManufacturer(value ?? ''); setGroup(''); setPointSearch(''); }} options={[...new Set(entries.map(({ template: item }) => item.manufacturer))].sort().map((value) => ({ value, label: value }))} />
          <Text type="secondary">模板库 · {filteredEntries.length} 个</Text>
          <div className="mt-template-list">{filteredEntries.map((item) => <button key={item.template.id} disabled={disabled} className={`mt-template-item${template?.id === item.template.id ? ' selected' : ''}`} onClick={() => choose(item.template)}>
            <Space><FolderOpenOutlined /><strong>{item.template.name}</strong></Space>
            <small>{item.template.models.join(' / ') || '自定义设备'}</small><small>{item.template.protocol_version} · {item.template.points.length} 个点位 · {item.origin === 'builtin' ? '内置' : '个人'}</small>
          </button>)}{!filteredEntries.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的模板" />}</div>
        </aside>
        <section className="mt-detail">{template ? <>
          <div className="mt-heading"><div><Title level={5}>{template.name}</Title><Text type="secondary">{template.protocol_version} · {template.models.join(' / ') || '自定义设备'}</Text></div>
            <Space><Button size="small" icon={<DownloadOutlined />} disabled={disabled} onClick={() => void exportFile()}>导出</Button>
              {entry.origin === 'personal' && <Popconfirm title="删除此个人模板？已应用的点位不受影响。" okText="删除" cancelText="取消" onConfirm={() => void removeCurrent()}><Button size="small" danger icon={<DeleteOutlined />} disabled={disabled}>删除</Button></Popconfirm>}</Space></div>
          <div className="mt-meta"><Text type="secondary">模板地址：{template.address_base} 基 → 连接地址：{addressBase === 2 ? '1' : '0'} 基</Text>
            <Tooltip title={template.sources.map((source) => `${source.file} (${source.sha256})`).join('\n')}><Text type="secondary">{template.sources.length ? `${template.sources.length} 份协议文档` : '来自用户配置'}</Text></Tooltip>
            <Button type="link" size="small" onClick={() => modal.info({ title: `${template.name} · 适用说明`, width: 720,
              content: <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>{template.notes.map((note, index) => <p style={{ marginBottom: 12 }} key={index}>{note}</p>)}</div>, okText: '已阅读',
            })}>适用说明</Button></div>
          <div className="mt-prefix"><label htmlFor="modbus-template-prefix">标签前缀（可选）</label><Input id="modbus-template-prefix" maxLength={256} disabled={disabled} placeholder="例如：逆变器01_" value={prefix} allowClear onChange={(event) => setPrefix(event.target.value)} /><Text type="secondary">预览中显示最终标签和连接地址</Text></div>
          <div className="mt-filters"><Input prefix={<SearchOutlined />} aria-label="搜索点位" placeholder="搜索点位名称或地址" allowClear value={pointSearch} onChange={(event) => setPointSearch(event.target.value)} />
            <Select aria-label="点位分组" placeholder="全部分组" value={group || undefined} allowClear onChange={(value) => setGroup(value ?? '')} options={[...new Set(template.points.map((point) => point.group))].map((value) => ({ value, label: value }))} /></div>
          <div className="mt-selection"><Checkbox disabled={disabled} checked={currentSelection.length === template.points.length} indeterminate={currentSelection.length > 0 && currentSelection.length < template.points.length}
            onChange={(event) => selectRows(event.target.checked ? template.points.map((point) => point.id) : [])}>全部点位</Checkbox>
            <Space wrap><Button size="small" type="link" disabled={disabled} onClick={() => selectRows(initialSelection(template))}>常用采集点</Button>
              <Button size="small" type="link" disabled={disabled} onClick={() => selectRows(visibleRows.map((row) => row.id))}>仅选筛选结果</Button>
              <Button size="small" type="link" disabled={disabled} onClick={() => selectRows([])}>清空选择</Button><Text type="secondary">显示 {visibleRows.length} / {template.points.length}</Text></Space></div>
          <div className="mt-table-area" ref={setTableArea}><Table<TemplateApplicationRow> rowKey="id" size="small" columns={columns} dataSource={visibleRows} pagination={false} scroll={{ x: 1010, y: tableHeight }}
            rowSelection={{ selectedRowKeys: currentSelection, preserveSelectedRowKeys: true, onChange: (keys) => selectRows(keys.map(String)), getCheckboxProps: () => ({ disabled }) }} locale={{ emptyText: '没有符合筛选条件的点位' }} /></div>
          {(skipped > 0 || writes > 0 || conditionCount > 0) && <div className="mt-summary"><Text type="warning">{skipped ? `${skipped} 个冲突点位将跳过。` : ''}{writes ? `已选 ${writes} 个写控制点。` : ''}{conditionCount ? `有 ${conditionCount} 个点位需核对适用条件。` : ''}</Text></div>}
        </> : <Empty description="没有匹配的模板，请调整搜索或导入模板" />}</section>
      </div>
    </Modal>
    <Modal title="保存当前点表为个人模板" open={saveOpen} onCancel={() => { if (!disabled) setSaveOpen(false); }} onOk={() => void saveCurrent()} confirmLoading={working} okText="保存模板" cancelText="取消">
      <Form form={saveForm} layout="vertical"><Form.Item name="name" label="模板名称" rules={[{ required: true, whitespace: true, message: '请输入模板名称' }]}><Input maxLength={120} /></Form.Item>
        <Form.Item name="manufacturer" label="厂家（可选）"><Input maxLength={80} /></Form.Item><Form.Item name="model" label="适用型号（可选）"><Input maxLength={160} /></Form.Item>
        <Text type="secondary">保存 {existingPoints.length} 个点位的地址、类型、倍率和字节序，可在其他连接复用。请核对实际设备的适用型号。</Text></Form>
    </Modal>
  </>;
}
