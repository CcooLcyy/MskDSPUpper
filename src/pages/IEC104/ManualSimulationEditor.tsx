import { useMemo, useRef, useState } from 'react';
import { Alert, Input, InputNumber, Modal, Select, Space, Table, Typography } from 'antd';
import type { Iec104ManualSimulationPoint, Iec104Point, Iec104SimulationSnapshot } from '../../adapters';
import { buildManualSimulationDraft, buildManualSimulationPoints, type ManualSimulationDraft } from './manual-simulation';

interface Props {
  connName: string;
  points: Iec104Point[];
  snapshot: Iec104SimulationSnapshot | null;
  loading: boolean;
  onSave: (points: Iec104ManualSimulationPoint[]) => Promise<void>;
  onCancel: () => void;
}

/** 每次打开挂载新草稿，关闭直接丢弃；只有保存成功才更新运行快照。 */
export default function ManualSimulationEditor({ connName, points, snapshot, loading, onSave, onCancel }: Props) {
  const [rows, setRows] = useState(() => buildManualSimulationDraft(points, snapshot));
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string>();
  const savingRef = useRef(false);
  const visibleRows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return rows.filter((row) => !query || row.tag.toLocaleLowerCase().includes(query)
      || String(row.ioa).includes(query) || `0x${row.ioa.toString(16)}`.includes(query));
  }, [rows, search]);
  const selectedKeys = rows.filter((row) => row.selected).map((row) => row.tag);
  const updateValue = (tag: string, value: number | boolean | undefined) => {
    setRows((current) => current.map((row) => row.tag === tag ? { ...row, value } : row));
    setError(undefined);
  };
  const save = async () => {
    if (loading || savingRef.current) return;
    savingRef.current = true;
    try {
      setError(undefined);
      await onSave(buildManualSimulationPoints(rows));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      savingRef.current = false;
    }
  };
  return (
    <Modal
      open title={`手动选点模拟 · ${connName}`} width={920}
      okText="保存模拟值" cancelText="取消" confirmLoading={loading}
      cancelButtonProps={{ disabled: loading }} closable={!loading} maskClosable={!loading}
      keyboard={!loading} onCancel={onCancel} onOk={() => void save()}
      okButtonProps={{ disabled: rows.length === 0 }}
    >
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="临时模拟与点表中的“固定上报值”分别管理"
        description="只模拟勾选的点，其余点继续原有数据路径；保存会替换当前模拟快照，取消勾选即退出该点模拟。遥测填写工程量，发送时沿用点表倍率与偏移；不修改固定上报配置。保存后可用“应用并发送”主动发送，全部退出请用“清除模拟值”。"
      />
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search aria-label="搜索模拟点" placeholder="搜索 Tag、IOA（十进制或 0x 十六进制）" allowClear
          style={{ width: 360 }} value={search} onChange={(event) => setSearch(event.target.value)} disabled={loading} />
        <Typography.Text>已选 {selectedKeys.length} / {rows.length} 点</Typography.Text>
      </Space>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      <Table<ManualSimulationDraft>
        size="small" rowKey="tag" dataSource={visibleRows} scroll={{ x: 720, y: 400 }}
        pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: [20, 50, 100], showTotal: (total) => `共 ${total} 点` }}
        rowSelection={{
          selectedRowKeys: selectedKeys, preserveSelectedRowKeys: true,
          getCheckboxProps: () => ({ disabled: loading }),
          onChange: (keys) => {
            const selected = new Set(keys);
            setRows((current) => current.map((row) => ({ ...row, selected: selected.has(row.tag) })));
            setError(undefined);
          },
        }}
        columns={[
          { title: 'IOA', dataIndex: 'ioa', width: 100 },
          { title: 'Tag', dataIndex: 'tag', width: 250 },
          { title: '类型', width: 90, render: (_, row) => row.point_type === 2 ? '遥信' : '遥测' },
          { title: '临时模拟值', width: 220, render: (_, row) => row.point_type === 2
            ? <Select aria-label={`${row.tag} 模拟值`} placeholder="选择 0 或 1" allowClear style={{ width: '100%' }}
              value={typeof row.value === 'boolean' ? Number(row.value) : undefined} disabled={loading}
              options={[{ value: 0, label: '0' }, { value: 1, label: '1' }]}
              onChange={(value: number | undefined) => updateValue(row.tag, value === undefined ? undefined : value === 1)} />
            : <InputNumber aria-label={`${row.tag} 模拟值`} placeholder="填写工程量" style={{ width: '100%' }}
              value={typeof row.value === 'number' ? row.value : null} disabled={loading}
              onChange={(value) => updateValue(row.tag, value ?? undefined)} /> },
        ]}
        locale={{ emptyText: rows.length === 0 ? '没有可模拟的遥测或遥信点（固定上报点不参与临时模拟）' : '没有匹配的点' }}
      />
    </Modal>
  );
}
