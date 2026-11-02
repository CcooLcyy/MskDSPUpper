import { useState } from 'react';
import { Select, Space } from 'antd';
import type { DcEndpoint } from '../../adapters';
import { controlEndpointKey } from '../../utils/control-mapping-editor';
import { buildConnectionPointOptions, filterConnectionPoints, pointConnectionKey } from '../../utils/connection-point-options';
import type { ConnectionPointOption } from '../../utils/connection-point-options';

/** 先按连接筛选，再选已有点位；浏览其他连接时保留绑定草稿。 */
export default function ConnectionPointSelect({ label, options, selected, loading, disabled, onChange }: {
  label: string;
  options: ConnectionPointOption[];
  selected: DcEndpoint[];
  loading: boolean;
  disabled: boolean;
  onChange: (endpoints: DcEndpoint[]) => void;
}) {
  const [connection, setConnection] = useState<string>();
  const { all, connections } = buildConnectionPointOptions(options, selected);
  const activeConnection = connection ?? (selected[0] ? pointConnectionKey(selected[0]) : undefined);
  const multiple = selected.length > 1;
  return <Space orientation="vertical" style={{ width: '100%' }}>
    <Select showSearch optionFilterProp="label" aria-label={`${label}连接`} style={{ width: '100%' }}
      value={activeConnection} options={connections} loading={loading} disabled={disabled}
      placeholder="先选择连接" notFoundContent="暂无连接，请先在协议点表中建立点位"
      onChange={(value) => {
        setConnection(value);
        console.info('[控制策略] 切换点位连接筛选，保留已有绑定', { field: label, connection: value });
      }} />
    <Select<string | string[]> showSearch allowClear optionFilterProp="label" aria-label={label} style={{ width: '100%' }}
      mode={multiple ? 'multiple' : undefined}
      value={multiple ? selected.map(controlEndpointKey) : selected[0] ? controlEndpointKey(selected[0]) : undefined}
      labelRender={({ value }) => all.get(String(value))?.label ?? String(value)}
      options={filterConnectionPoints([...all.values()], activeConnection)} loading={loading}
      disabled={disabled || !activeConnection} placeholder={activeConnection ? '搜索点名，选择已有点位' : '请先选择连接'}
      notFoundContent="该连接暂无可选点位，请刷新或在协议点表中建立点位"
      onChange={(value) => onChange((Array.isArray(value) ? value : value ? [value] : [])
        .flatMap((key) => all.get(key)?.endpoint ? [all.get(key)!.endpoint] : []))} />
  </Space>;
}
