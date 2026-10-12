import { Alert, Button, Form, Input, InputNumber, Select, Space, Typography } from 'antd';
import type { FormInstance } from 'antd';
import { useEffect, useRef } from 'react';
import type { AgcMemberConfig, DcEndpoint } from '../../adapters';
import { PARAMETER_HELP } from '../help/parameter-help';
import { controlEndpointKey } from '../../utils/control-mapping-editor';
import type { AgcMemberEndpoints, AgcMemberPointKind } from '../../utils/agc-member-bindings';
import type { ControlAllocationMode } from '../../utils/control-allocation';

type PointOption = { value: string; label: string; endpoint: DcEndpoint };

/** 在控制组内选择成员的已有点位，协议点表负责工程量和读写配置。 */
export default function AgcMemberEditor({
  form, editing, allocationMode, options, endpoints, loading, error, warning, submitting,
  validateDecimal, onDirty, onSelect, onCancel, onSubmit, onRefresh,
}: {
  form: FormInstance<AgcMemberConfig>;
  editing: boolean;
  allocationMode: ControlAllocationMode;
  options: PointOption[];
  endpoints: AgcMemberEndpoints;
  loading: boolean;
  error: string | null;
  warning: string | null;
  submitting: boolean;
  validateDecimal: (value: unknown, label: string, range?: 'any' | 'nonnegative' | 'positive') => void;
  onDirty: () => void;
  onSelect: (kind: AgcMemberPointKind, endpoints: DcEndpoint[]) => void;
  onCancel: () => void;
  onSubmit: () => void;
  onRefresh: () => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    editorRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);
  const controllable = Form.useWatch('controllable', form) ?? true;
  const name = Form.useWatch('member_name', form) || '成员';
  const mode = Form.useWatch(['p_set', 'mode'], form) ?? 1;
  const deltaBase = Form.useWatch(['p_set', 'delta_base'], form) ?? 0;
  const pointPicker = (kind: AgcMemberPointKind, label: string) => {
    const selected = endpoints[kind] ?? [];
    const allOptions = new Map(options.map((option) => [option.value, option]));
    for (const endpoint of selected) {
      const value = controlEndpointKey(endpoint);
      if (!allOptions.has(value)) allOptions.set(value, {
        value, endpoint, label: `${endpoint.module_name} / ${endpoint.conn_name} / ${endpoint.tag}（已有绑定）`,
      });
    }
    const multiple = selected.length > 1;
    return <Form.Item label={label} required>
      <Select<string | string[]> showSearch allowClear optionFilterProp="label" aria-label={label}
        mode={multiple ? 'multiple' : undefined}
        value={multiple ? selected.map(controlEndpointKey) : selected[0] ? controlEndpointKey(selected[0]) : undefined}
        options={[...allOptions.values()]} loading={loading} disabled={loading || Boolean(error) || submitting}
        placeholder="搜索协议、连接或点名，选择已有点位"
        notFoundContent="暂无可选点位，请先在协议点表中建立点位"
        onChange={(value) => onSelect(kind, (Array.isArray(value) ? value : value ? [value] : []).map((key) => allOptions.get(key)!.endpoint))}
      />
      {multiple && <Typography.Text type="secondary" className="agc-member-editor__note">保留全部已有绑定；多来源可能覆盖同一输入值，请确认来源关系。</Typography.Text>}
    </Form.Item>;
  };
  const routeLine = (kind: AgcMemberPointKind, input: boolean) => (endpoints[kind] ?? []).map((endpoint) => (
    <div key={`${kind}-${controlEndpointKey(endpoint)}`}>
      {input ? `${endpoint.module_name} / ${endpoint.conn_name} / ${endpoint.tag} → ${name} ${kind === 'base_tag' ? '增量基准' : '测量输入'}`
        : `${name} 控制输出 → ${endpoint.module_name} / ${endpoint.conn_name} / ${endpoint.tag}`}
    </div>
  ));
  return <div className="agc-member-editor" ref={editorRef}>
    <div className="agc-member-editor__heading">
      <Typography.Text strong>{editing ? '编辑成员' : '添加成员'}</Typography.Text>
      <Button size="small" loading={loading} onClick={onRefresh} disabled={submitting}>刷新已有点位</Button>
    </div>
    {error && <Alert type="error" showIcon title={error} description="点位与映射读取失败，请刷新后再保存。" />}
    {warning && <Alert type="warning" showIcon title={warning} />}
    <Form form={form} layout="vertical" size="small" disabled={submitting} onValuesChange={onDirty}>
      <div className="agc-member-editor__identity">
        <Form.Item name="member_name" label="成员名称" rules={[{ required: true, whitespace: true, message: '请输入成员名称' }]}>
          <Input placeholder="例如：逆变器1" />
        </Form.Item>
        <Form.Item name="controllable" label="参与控制"
          getValueProps={(value: boolean) => ({ value: value ? 'yes' : 'no' })}
          getValueFromEvent={(value: string) => value === 'yes'}>
          <Select options={[{ value: 'yes', label: '可控成员' }, { value: 'no', label: '仅参与测量' }]} />
        </Form.Item>
      </div>
      <Typography.Text strong className="agc-member-editor__section-title">绑定已有点位</Typography.Text>
      {pointPicker('p_meas', '有功测量点')}
      {controllable && pointPicker('p_set', '有功设定点')}
      <Typography.Text type="secondary" className="agc-member-editor__note">工程量换算与点位读写在协议点表中配置，AGC 使用 kW 工程量。</Typography.Text>
      <Typography.Text strong className="agc-member-editor__section-title">控制参数</Typography.Text>
      <div className="agc-member-editor__limits">
        <Form.Item name="capacity_kw_decimal" label="额定容量（kW）" tooltip={PARAMETER_HELP.control.capacity}
          rules={[{ validator: async (_rule, value) => validateDecimal(value, '额定容量', 'positive') }]}>
          <InputNumber<string> stringMode step="0.1" style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="min_kw_decimal" label="有功下限（kW）" tooltip={PARAMETER_HELP.control.activeLimits}
          rules={[{ validator: async (_rule, value) => validateDecimal(value, '最小可调有功', 'nonnegative') }]}>
          <InputNumber<string> stringMode step="0.1" style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="max_kw_decimal" label="有功上限（kW）" tooltip={PARAMETER_HELP.control.activeLimits}
          rules={[{ validator: async (_rule, value) => validateDecimal(value, '最大可调有功', 'nonnegative') }]}>
          <InputNumber<string> stringMode step="0.1" style={{ width: '100%' }} />
        </Form.Item>
      </div>
      {allocationMode === 'custom' && controllable && <Form.Item name="weight_decimal" label="调节权重" tooltip={PARAMETER_HELP.control.weight}
        rules={[{ validator: async (_rule, value) => validateDecimal(value, '权重', 'positive') }]}>
        <InputNumber<string> stringMode step="0.1" style={{ width: '100%' }} />
      </Form.Item>}
      {controllable && <details className="agc-member-editor__advanced" open={mode === 2}>
        <summary>更多控制参数</summary>
        <div className="agc-member-editor__identity">
          <Form.Item name={['p_set', 'mode']} label="指令模式" tooltip={PARAMETER_HELP.control.commandMode}>
            <Select options={[{ value: 1, label: '绝对值' }, { value: 2, label: '增量值' }]} />
          </Form.Item>
          {mode === 2 && <Form.Item name={['p_set', 'delta_base']} label="增量基准" tooltip={PARAMETER_HELP.control.deltaBase}
            rules={[{ required: true, message: '请选择增量基准' }, { validator: async (_rule, value) => {
              if (![1, 2, 3].includes(value)) throw new Error('请选择增量基准');
            } }]}>
            <Select options={[{ value: 1, label: '上一轮目标值' }, { value: 2, label: '当前实测值' }, { value: 3, label: '指定基准点' }]} />
          </Form.Item>}
        </div>
        {mode === 2 && deltaBase === 3 && pointPicker('base_tag', '增量基准点')}
      </details>}
      <div className="agc-member-editor__routes" aria-live="polite">
        <Typography.Text type="secondary">保存控制组时自动建立点位绑定</Typography.Text>
        {routeLine('p_meas', true)}
        {controllable && routeLine('p_set', false)}
        {controllable && mode === 2 && deltaBase === 3 && routeLine('base_tag', true)}
      </div>
      <div className="agc-member-editor__footer">
        <Typography.Text type="secondary">最终保存时会一并保存当前编辑的成员</Typography.Text>
        <Space><Button onClick={onCancel} disabled={submitting}>取消编辑</Button>
          <Button type="primary" onClick={onSubmit} loading={submitting} disabled={loading || Boolean(error)}>完成成员编辑</Button></Space>
      </div>
    </Form>
  </div>;
}
