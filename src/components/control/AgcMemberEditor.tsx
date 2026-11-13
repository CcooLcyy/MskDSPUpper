import { Alert, Button, Form, Input, InputNumber, Select, Typography } from 'antd';
import type { FormInstance } from 'antd';
import type { AgcMemberConfig, DcEndpoint } from '../../adapters';
import { PARAMETER_HELP } from '../help/parameter-help';
import { controlEndpointKey } from '../../utils/control-mapping-editor';
import type { AgcMemberEndpoints, AgcMemberPointKind } from '../../utils/agc-member-bindings';
import type { ControlAllocationMode } from '../../utils/control-allocation';
import { compareAgcDecimalTexts } from '../../utils/agc-decimal';
import { getDecimalTextError, toDecimalInputText } from '../../utils/decimal-input';

import ConnectionPointSelect from './ConnectionPointSelect';

type PointOption = { value: string; label: string; endpoint: DcEndpoint };

/** 在成员弹窗中选择已有点位，协议点表负责工程量和读写配置。 */
export default function AgcMemberEditor({
  form, allocationMode, options, endpoints, loading, error, warning, submitting,
  validateDecimal, onDirty, onSelect, onRefresh,
}: {
  form: FormInstance<AgcMemberConfig>;
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
  onRefresh: () => void;
}) {
  const controllable = Form.useWatch('controllable', form) ?? true;
  const name = Form.useWatch('member_name', form) || '成员';
  const mode = Form.useWatch(['p_set', 'mode'], form) ?? 1;
  const deltaBase = Form.useWatch(['p_set', 'delta_base'], form) ?? 0;
  const communicationTag = Form.useWatch(['communication_state', 'tag'], { form, preserve: true });
  const communicationBound = Boolean(endpoints.communication_state?.length) || Boolean(communicationTag);
  const capacity = Form.useWatch('capacity_kw_decimal', form);
  const handleValuesChange = (changed: Partial<AgcMemberConfig>) => {
    if ('capacity_kw_decimal' in changed) {
      const previousCapacity = toDecimalInputText(capacity);
      const maximum = toDecimalInputText(form.getFieldValue('max_kw_decimal'));
      // 上限为空或仍等于原额定容量时继续跟随；保留用户单独设定的上限。
      const followsCapacity = !maximum || maximum === previousCapacity
        || (!getDecimalTextError(maximum, '有功上限') && !getDecimalTextError(previousCapacity, '额定容量')
          && compareAgcDecimalTexts(maximum, previousCapacity) === 0);
      if (followsCapacity) form.setFieldValue('max_kw_decimal', changed.capacity_kw_decimal);
    }
    onDirty();
  };
  const pointPicker = (kind: AgcMemberPointKind, label: string) => {
    const selected = endpoints[kind] ?? [];
    const multiple = selected.length > 1;
    const choices = kind === 'communication_state'
      ? options.filter(option => option.endpoint.tag === '__communication_state' || selected.some(endpoint => controlEndpointKey(endpoint) === option.value))
      : options.filter(option => option.endpoint.tag !== '__communication_state' || selected.some(endpoint => controlEndpointKey(endpoint) === option.value));
    return <Form.Item label={label} required={kind !== 'communication_state'}>
      <ConnectionPointSelect label={label} options={choices} selected={selected}
        loading={loading} disabled={loading || Boolean(error) || submitting}
        onChange={(values) => onSelect(kind, values)} />
      {multiple && <Typography.Text type="secondary" className="agc-member-editor__note">保留全部已有绑定；多来源可能覆盖同一输入值，请确认来源关系。</Typography.Text>}
    </Form.Item>;
  };
  const routeLine = (kind: AgcMemberPointKind, input: boolean) => (endpoints[kind] ?? []).map((endpoint) => (
    <div key={`${kind}-${controlEndpointKey(endpoint)}`}>
      {input ? `${endpoint.module_name} / ${endpoint.conn_name} / ${endpoint.tag} → ${name} ${kind === 'base_tag' ? '增量基准' : kind === 'communication_state' ? '通信状态' : '测量输入'}`
        : `${name} 控制输出 → ${endpoint.module_name} / ${endpoint.conn_name} / ${endpoint.tag}`}
    </div>
  ));
  return <div className="agc-member-editor">
    <div className="agc-member-editor__heading">
      <Typography.Text strong>成员信息</Typography.Text>
      <Button size="small" loading={loading} onClick={onRefresh} disabled={submitting}>刷新已有点位</Button>
    </div>
    {error && <Alert type="error" showIcon title={error} description="点位与映射读取失败，请刷新后再保存。" />}
    {warning && <Alert type="warning" showIcon title={warning} />}
    <Form form={form} layout="vertical" size="small" disabled={submitting} onValuesChange={handleValuesChange}>
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
      {pointPicker('communication_state', '通信状态点（可选）')}
      {communicationBound && <Button type="link" size="small" onClick={() => onSelect('communication_state', [])}>清除通信状态关联</Button>}
      {communicationBound && <Form.Item name="communication_timeout_ms" label="通信心跳超时（毫秒）"
        getValueProps={(value: number | undefined) => ({ value: value || 30000 })}
        rules={[{ validator: async (_rule, value) => {
          if (!Number.isInteger(value) || value < 1000 || value > 3600000) throw new Error('通信心跳超时须为 1000～3600000 毫秒');
        } }]}>
        <InputNumber min={1000} max={3600000} step={1000} precision={0} style={{ width: '100%' }} />
      </Form.Item>}
      <Typography.Text type="secondary" className="agc-member-editor__note">关联后仅通信正常的可控成员参与调节；清空关联恢复原行为。默认超时 30000 毫秒。</Typography.Text>
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
          <Form.Item name="measurement_validity_ms" label="量测有效期（毫秒）"
            tooltip="可控成员有功量测过期后退出分配，收到新的有效量测后恢复。0 表示关闭。"
            rules={[{ validator: async (_rule, value: number | null | undefined) => {
              const validity = value ?? 0;
              if (validity !== 0 && (!Number.isInteger(validity) || validity < 1000 || validity > 3600000)) {
                throw new Error('量测有效期须为 0 或 1000～3600000 毫秒的整数');
              }
            } }]}>
            <InputNumber min={0} max={3600000} step={1000} style={{ width: '100%' }} />
          </Form.Item>
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
        {routeLine('communication_state', true)}
        {controllable && routeLine('p_set', false)}
        {controllable && mode === 2 && deltaBase === 3 && routeLine('base_tag', true)}
      </div>
    </Form>
  </div>;
}
