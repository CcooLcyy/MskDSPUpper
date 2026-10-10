import { Alert, Button, Card, Select, Space, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { ControlMappingsDraft } from './useControlMappings';
import { controlEndpointKey, controlMappingFieldKey } from '../../utils/control-mapping-editor';
import type { ControlMappingField } from '../../utils/control-mapping-editor';

/** 外部映射单独编辑，保留本地 tag 和已有的一对多路由。 */
export default function ControlMappingsEditor({ mapping, fields, groupName = mapping.groupName }: { mapping: ControlMappingsDraft; fields: ControlMappingField[]; groupName?: string }) {
  const uniqueFields = [...new Map(fields.filter((field) => field.tag?.trim()).map((field) => [controlMappingFieldKey(field), field])).values()];
  return (
    <Card className="control-config-section" size="small" title="外部点位映射" extra={
      <Button size="small" icon={<ReloadOutlined />} loading={mapping.loading} onClick={() => void mapping.refresh()}>刷新点位与映射</Button>
    }>
      <Typography.Paragraph type="secondary">
        本地点位 tag 与外部点位分别配置。保存控制组时只同步明确修改的映射，其他路由保留。多来源可能覆盖同一输入值，请确认来源关系。
      </Typography.Paragraph>
      {mapping.error && <Alert type="error" showIcon title={mapping.error} description="已有映射未加载完成，保存已禁用；请刷新重试。" />}
      {mapping.warning && <Alert type="warning" showIcon title={mapping.warning} />}
      {uniqueFields.length === 0 && <Typography.Text type="secondary">先填写本地点位 tag 或暂存成员，再配置外部映射。</Typography.Text>}
      {uniqueFields.map((field) => {
        const selected = mapping.getEndpoints(field);
        const options = new Map(mapping.options.map((option) => [option.value, option]));
        selected.forEach((endpoint) => {
          const value = controlEndpointKey(endpoint);
          if (!options.has(value)) options.set(value, { value, label: `${endpoint.module_name} / ${endpoint.conn_name} / ${endpoint.tag}（已有端点）`, endpoint });
        });
        const externalOptions = [...options.values()].filter((option) => option.endpoint.module_name !== mapping.moduleName || option.endpoint.conn_name !== groupName.trim());
        return <div key={controlMappingFieldKey(field)} style={{ marginBottom: 16 }}>
          <Space wrap style={{ marginBottom: 6 }}>
            <Typography.Text strong>{field.label}</Typography.Text>
            <Tag>{field.direction === 'input' ? '数据来源 → 控制组' : '控制组 → 发送目标'}</Tag>
            <Typography.Text code>{field.tag}</Typography.Text>
          </Space>
          <Select mode="multiple" showSearch allowClear style={{ width: '100%' }} loading={mapping.loading}
            disabled={mapping.loading || Boolean(mapping.error)} optionFilterProp="label"
            aria-label={`${field.label}${field.direction === 'input' ? '数据来源' : '发送目标'}`}
            placeholder={field.direction === 'input' ? '选择外部数据来源；清空可解除已有映射' : '选择外部发送目标；清空可解除已有映射'}
            value={selected.map(controlEndpointKey)} options={externalOptions}
            onChange={(values: string[]) => mapping.setEndpoints(field, values.map((value) => options.get(value)!.endpoint))}
          />
        </div>;
      })}
    </Card>
  );
}
