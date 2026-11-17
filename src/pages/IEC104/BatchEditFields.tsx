import { Alert, Col, Form, Input, Row, Select, Space, Typography } from 'antd';
import {
  BATCH_ENGINEERING_FIELDS,
  POINT_TYPE_FLOAT,
  POINT_TYPE_LABELS,
  POINT_TYPE_SINGLE,
  type Iec104BatchEdit,
  type planIec104BatchEdit,
} from './batch-edit';
import { IOA_CATEGORY_OPTIONS, POINT_BUSINESS_TYPE_OPTIONS, type IoaBusinessCategoryKey } from './ioa-category';
import { COMMAND_EXECUTION_MODE_OPTIONS, REMOTE_CONTROL_TYPE_OPTIONS } from './remote-control';

const businessTypeOptions = POINT_BUSINESS_TYPE_OPTIONS.map((option) =>
  option.value === 0 ? { ...option, label: '按 IOA 推导' } : option);
const fixedValueOptions = [{ label: '开启', value: 'on' }, { label: '关闭', value: 'off' }];
const singleValueOptions = [{ label: '0 (分)', value: '0' }, { label: '1 (合)', value: '1' }];
const pointTypeOptions = [POINT_TYPE_FLOAT, POINT_TYPE_SINGLE].map((value) => ({ value, label: POINT_TYPE_LABELS[value] }));

type Props = {
  patch: Iec104BatchEdit;
  plan: ReturnType<typeof planIec104BatchEdit>;
  selectedCount: number;
  slaveStation: boolean;
  disabled: boolean;
  formatIoa: (ioa: number) => string;
  onChange: (patch: Iec104BatchEdit) => void;
};

export default function BatchEditFields({ patch, plan, selectedCount, slaveStation, disabled, formatIoa, onChange }: Props) {
  const setField = <K extends keyof Iec104BatchEdit>(key: K, value: Iec104BatchEdit[K]) => onChange({ ...patch, [key]: value });
  const fixedMode = patch.fixedValueEnabled === undefined ? undefined : patch.fixedValueEnabled ? 'on' : 'off';
  const showFixed = slaveStation || fixedMode !== undefined || patch.fixedValue !== undefined;
  const showRemote = plan.remoteControlCount > 0 || patch.remoteControlType !== undefined || patch.commandExecutionMode !== undefined;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert type="info" showIcon message={`已选 ${selectedCount} 个点位，预计修改 ${plan.changedCount} 个`}
        description="留空的字段保留原值。切换 FLOAT / SINGLE 会将工程参数重置为 1、0、0；可为修改后的 FLOAT 点位同时填写新参数。" />
      <Form component={false} layout="vertical" disabled={disabled} size="small">
        <Row gutter={12}>
          <Col xs={24} sm={8}>
            <Form.Item label="IOA 业务类别" tooltip="按目标地址段迁移，段内原地址保留。自定义地址请使用 IOA 调整。">
              <Select<IoaBusinessCategoryKey> aria-label="IOA 业务类别" allowClear placeholder="保留原值"
                options={IOA_CATEGORY_OPTIONS} value={patch.ioaCategory} onChange={(value) => setField('ioaCategory', value)} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={8}>
            <Form.Item label="业务类型" tooltip="决定点位的上报或命令行为，可以独立于 IOA 地址段设置。">
              <Select<number> aria-label="业务类型" allowClear placeholder="保留原值"
                options={businessTypeOptions} value={patch.businessType} onChange={(value) => setField('businessType', value)} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={8}>
            <Form.Item label="类型 (Type)">
              <Select<number> aria-label="类型 (Type)" allowClear placeholder="保留原值"
                options={pointTypeOptions} value={patch.pointType} onChange={(value) => setField('pointType', value)} />
            </Form.Item>
          </Col>
          {showFixed ? <>
            <Col xs={24} sm={12}>
              <Form.Item label="固定上报值" extra={`适用于修改后的 ${plan.fixedValueCount} 个从站遥测或遥信点`}>
                <Select<'on' | 'off'> aria-label="固定上报值" allowClear placeholder="保留原值"
                  options={fixedValueOptions} value={fixedMode}
                  disabled={disabled || (!plan.fixedValueCount && fixedMode === undefined)}
                  onChange={(value) => setField('fixedValueEnabled', value === undefined ? undefined : value === 'on')} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label="固定报文数值" extra="SINGLE 只接受 0 或 1；单独填写数值不会开启固定上报。">
                {plan.singleFixedValueCount > 0 ? (
                  <Select<string> aria-label="固定报文数值" allowClear placeholder="保留原值" options={singleValueOptions}
                    value={patch.fixedValue} onChange={(value) => setField('fixedValue', value)} />
                ) : (
                  <Input aria-label="固定报文数值" allowClear placeholder="保留原值" value={patch.fixedValue ?? ''}
                    disabled={disabled || (!plan.fixedValueCount && patch.fixedValue === undefined)}
                    onChange={(event) => setField('fixedValue', event.target.value || undefined)} />
                )}
              </Form.Item>
            </Col>
          </> : null}
          {BATCH_ENGINEERING_FIELDS.map(({ key, label }) => (
            <Col key={key} xs={24} sm={8}>
              <Form.Item label={label} tooltip={`适用于修改后的 ${plan.floatCount} 个 FLOAT 点位；固定上报期间仅保存这些参数。`}>
                <Input aria-label={label} allowClear placeholder="保留原值" value={patch[key] ?? ''}
                  disabled={disabled || (!plan.floatCount && patch[key] === undefined)}
                  onChange={(event) => setField(key, event.target.value || undefined)} />
              </Form.Item>
            </Col>
          ))}
          {showRemote ? <>
            <Col xs={24} sm={12}>
              <Form.Item label="遥控命令类型" extra={`仅作用于修改后的 ${plan.remoteControlCount} 个遥控点位`}>
                <Select<number> aria-label="遥控命令类型" allowClear placeholder="保留原值"
                  value={patch.remoteControlType} options={REMOTE_CONTROL_TYPE_OPTIONS}
                  disabled={disabled || (!plan.remoteControlCount && patch.remoteControlType === undefined)}
                  onChange={(value) => setField('remoteControlType', value)} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label="命令执行方式">
                <Select<number> aria-label="命令执行方式" allowClear placeholder="保留原值"
                  value={patch.commandExecutionMode} options={COMMAND_EXECUTION_MODE_OPTIONS}
                  disabled={disabled || (!plan.remoteControlCount && patch.commandExecutionMode === undefined)}
                  onChange={(value) => setField('commandExecutionMode', value)} />
              </Form.Item>
            </Col>
          </> : null}
        </Row>
      </Form>
      {plan.issues.length > 0 ? (
        <Alert type="error" showIcon message="请先修正批量配置"
          description={<ul style={{ margin: 0, paddingInlineStart: 20 }}>{plan.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>} />
      ) : null}
      {plan.releasedFixedValueCount > 0 ? (
        <Alert type="warning" showIcon message={`${plan.releasedFixedValueCount} 个点位修改后不再适用原固定值，将关闭固定上报并保留原数值。`} />
      ) : null}
      {plan.businessTypeChangedCount > 0 ? (
        <Alert type="warning" showIcon message={`${plan.businessTypeChangedCount} 个点位的业务类型将变化`}
          description="已有数据总线路由不会随业务类型重建。由上报改为控制或由控制改为上报时，请核对路由方向。" />
      ) : null}
      {plan.ioaChanges.length > 0 ? (
        <Alert type="warning" showIcon message={`${plan.ioaChanges.length} 个点位将迁移 IOA`}
          description={(
            <>
              <Typography.Paragraph>保存前请核对新地址并同步对端点表，未确认的 SOE 仍可能按原地址回放。</Typography.Paragraph>
              <ul aria-label="IOA 变更预览" style={{ maxHeight: 160, overflowY: 'auto', margin: 0, paddingInlineStart: 20 }}>
                {plan.ioaChanges.map(({ tag, before, after }) => <li key={tag}>{tag}：{formatIoa(before)} → {formatIoa(after)}</li>)}
              </ul>
            </>
          )} />
      ) : null}
    </Space>
  );
}
