import { Alert, Button, Form, Input, InputNumber, Select, Typography } from 'antd';
import type { FormInstance } from 'antd';
import type { AvcMemberConfig, DcEndpoint } from '../../adapters';
import { PARAMETER_HELP } from '../help/parameter-help';
import { controlEndpointKey } from '../../utils/control-mapping-editor';
import type { AvcMemberEndpoints, AvcMemberPointKind } from '../../utils/avc-member-bindings';
import type { ControlAllocationMode } from '../../utils/control-allocation';

type PointOption = { value: string; label: string; endpoint: DcEndpoint };

/** 在成员弹窗中选择已有点位，协议点表负责工程量和读写配置。 */
export default function AvcMemberEditor({
  form, allocationMode, options, endpoints, loading, error, warning, submitting,
  onDirty, onSelect, onRefresh,
}: {
  form: FormInstance<AvcMemberConfig>;
  allocationMode: ControlAllocationMode;
  options: PointOption[];
  endpoints: AvcMemberEndpoints;
  loading: boolean;
  error: string | null;
  warning: string | null;
  submitting: boolean;
  onDirty: () => void;
  onSelect: (kind: AvcMemberPointKind, endpoints: DcEndpoint[]) => void;
  onRefresh: () => void;
}) {
  const controllable = Form.useWatch('controllable', form) ?? true;
  const name = Form.useWatch('member_name', form) || '成员';
  const mode = Form.useWatch(['q_set', 'mode'], form) ?? 1;
  const deltaBase = Form.useWatch(['q_set', 'delta_base'], form) ?? 0;
  const validateFinite = (value: unknown, label: string) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`请输入有效的${label}`);
  };
  const pointPicker = (kind: AvcMemberPointKind, label: string) => {
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
        onChange={(value) => onSelect(kind, (Array.isArray(value) ? value : value ? [value] : [])
          .flatMap((key) => allOptions.get(key)?.endpoint ? [allOptions.get(key)!.endpoint] : []))}
      />
      {multiple && <Typography.Text type="secondary" className="agc-member-editor__note">
        {kind === 'q_set' ? '保留全部已有绑定；控制指令将发送到各设定点。' : '保留全部已有绑定；多来源可能覆盖同一输入值，请确认来源关系。'}
      </Typography.Text>}
    </Form.Item>;
  };
  const routeLine = (kind: AvcMemberPointKind, input: boolean) => (endpoints[kind] ?? []).map((endpoint) => (
    <div key={`${kind}-${controlEndpointKey(endpoint)}`}>
      {input ? `${endpoint.module_name} / ${endpoint.conn_name} / ${endpoint.tag} → ${name} ${kind === 'base_tag' ? '增量基准' : '测量输入'}`
        : `${name} 控制输出 → ${endpoint.module_name} / ${endpoint.conn_name} / ${endpoint.tag}`}
    </div>
  ));
  return <div className="agc-member-editor">
    <div className="agc-member-editor__heading">
      <Typography.Text strong>成员信息</Typography.Text>
      <Button size="small" loading={loading} onClick={() => {
        console.info('[AVC] 刷新成员可选点位，保留草稿与已有绑定');
        onRefresh();
      }} disabled={submitting}>刷新已有点位</Button>
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
      {pointPicker('q_meas', '无功测量点')}
      {controllable && pointPicker('q_set', '无功设定点')}
      <Typography.Text type="secondary" className="agc-member-editor__note">工程量换算与点位读写在协议点表中配置，AVC 使用 kVar 工程量。</Typography.Text>
      <Typography.Text strong className="agc-member-editor__section-title">控制参数</Typography.Text>
      <div className="agc-member-editor__limits">
        <Form.Item name="q_min_kvar" label="无功下限（kVar）" tooltip={PARAMETER_HELP.control.reactiveLimits}
          rules={[{ validator: async (_rule, value) => validateFinite(value, '无功下限') }]}>
          <InputNumber step={0.1} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="q_max_kvar" label="无功上限（kVar）" tooltip={PARAMETER_HELP.control.reactiveLimits}
          dependencies={['q_min_kvar', 'controllable']}
          rules={[{ validator: async (_rule, value) => {
            validateFinite(value, '无功上限');
            const minimum = form.getFieldValue('q_min_kvar');
            if (typeof minimum !== 'number' || !Number.isFinite(minimum)) return;
            if (value < minimum) throw new Error('无功上限不能小于下限');
            if (allocationMode === 'proportional' && controllable && value === minimum) {
              throw new Error('按可调范围分配的可控成员，无功上限必须大于下限');
            }
          } }]}>
          <InputNumber step={0.1} style={{ width: '100%' }} />
        </Form.Item>
      </div>
      {allocationMode === 'custom' && controllable && <Form.Item name="weight" label="调节权重" tooltip={PARAMETER_HELP.control.weight}
        rules={[{ validator: async (_rule, value) => {
          validateFinite(value, '调节权重');
          if (value <= 0) throw new Error('调节权重必须大于 0');
        } }]}>
        <InputNumber step={0.1} style={{ width: '100%' }} />
      </Form.Item>}
      {controllable && <details className="agc-member-editor__advanced" open={mode === 2}>
        <summary>更多控制参数</summary>
        <div className="agc-member-editor__identity">
          <Form.Item name={['q_set', 'mode']} label="指令模式" tooltip={PARAMETER_HELP.control.commandMode}>
            <Select options={[{ value: 1, label: '绝对值' }, { value: 2, label: '增量值' }]} />
          </Form.Item>
          {mode === 2 && <Form.Item name={['q_set', 'delta_base']} label="增量基准" tooltip={PARAMETER_HELP.control.deltaBase}
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
        {routeLine('q_meas', true)}
        {controllable && routeLine('q_set', false)}
        {controllable && mode === 2 && deltaBase === 3 && routeLine('base_tag', true)}
      </div>
    </Form>
  </div>;
}
