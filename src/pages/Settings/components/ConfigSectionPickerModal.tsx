import React from 'react';
import { Button, Checkbox, Divider, Modal, Radio, Space, Typography } from 'antd';
import type { ConfigExportSectionId } from '../../../adapters';
import type { ConfigImportMode, ConfigImportModeOption, ConfigSectionOption } from '../../../utils/config-export';

const { Text } = Typography;

interface ConfigSectionPickerModalProps {
  open: boolean;
  title: string;
  confirmText: string;
  options: ConfigSectionOption[];
  selectedKeys: ConfigExportSectionId[];
  confirmLoading?: boolean;
  extra?: React.ReactNode;
  importMode?: ConfigImportMode;
  importModeOptions?: ConfigImportModeOption[];
  importModeTitle?: string;
  onImportModeChange?: (value: ConfigImportMode) => void;
  onChange: (keys: ConfigExportSectionId[]) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function groupOptions(options: ConfigSectionOption[]): Array<{
  key: string;
  label: string;
  items: ConfigSectionOption[];
}> {
  const groups: Array<{ key: string; label: string; items: ConfigSectionOption[] }> = [];

  for (const option of options) {
    const groupLabel = option.groupLabel ?? 'Uncategorized';
    const currentGroup = groups[groups.length - 1];

    if (!currentGroup || currentGroup.label !== groupLabel) {
      groups.push({
        key: `${groups.length}-${groupLabel}`,
        label: groupLabel,
        items: [option],
      });
      continue;
    }

    currentGroup.items.push(option);
  }

  return groups;
}

function renderImportModeOption(
  option: ConfigImportModeOption,
  importMode: ConfigImportMode,
): React.ReactElement {
  const isSelected = option.key === importMode;

  return (
    <label key={option.key} style={{ display: 'block', cursor: 'pointer' }}>
      <div
        style={{
          padding: '10px 12px',
          border: isSelected ? '1px solid #1677ff' : '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: 8,
          background: isSelected ? 'rgba(22, 119, 255, 0.08)' : 'transparent',
        }}
      >
        <Radio value={option.key}>{option.label}</Radio>
        <div style={{ marginTop: 6, marginLeft: 24 }}>
          <Text type="secondary">{option.description}</Text>
        </div>
      </div>
    </label>
  );
}

const ConfigSectionPickerModal: React.FC<ConfigSectionPickerModalProps> = ({
  open,
  title,
  confirmText,
  options,
  selectedKeys,
  confirmLoading = false,
  extra,
  importMode,
  importModeOptions,
  importModeTitle,
  onImportModeChange,
  onChange,
  onCancel,
  onConfirm,
}) => {
  const enabledKeys = options.filter((option) => !option.disabled).map((option) => option.key);
  const selectedEnabledCount = selectedKeys.filter((key) => enabledKeys.includes(key)).length;
  const canConfirm = selectedEnabledCount > 0;
  const groupedOptions = groupOptions(options);
  const hasImportModeSelector =
    importMode !== undefined &&
    importModeOptions !== undefined &&
    importModeOptions.length > 0 &&
    onImportModeChange !== undefined;

  return (
    <Modal
      open={open}
      title={title}
      okText={confirmText}
      cancelText="取消"
      width={hasImportModeSelector ? 920 : undefined}
      okButtonProps={{ disabled: !canConfirm }}
      confirmLoading={confirmLoading}
      onCancel={onCancel}
      onOk={onConfirm}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 20,
          alignItems: 'flex-start',
        }}
      >
        {hasImportModeSelector ? (
          <div
            style={{
              flex: '0 0 280px',
              width: 280,
              maxWidth: '100%',
            }}
          >
            <Text strong style={{ display: 'block', marginBottom: 10 }}>
              {importModeTitle ?? '导入方式'}
            </Text>
            <Radio.Group
              value={importMode}
              onChange={(event) => onImportModeChange(event.target.value as ConfigImportMode)}
              style={{ width: '100%' }}
            >
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {importModeOptions.map((option) => renderImportModeOption(option, importMode))}
              </Space>
            </Radio.Group>
          </div>
        ) : null}

        <div
          style={{
            flex: hasImportModeSelector ? '1 1 520px' : '1 1 100%',
            minWidth: 0,
          }}
        >
          <Space wrap style={{ marginBottom: 12 }}>
            <Button size="small" onClick={() => onChange(enabledKeys)} disabled={enabledKeys.length === 0}>
              全选
            </Button>
            <Button size="small" onClick={() => onChange([])} disabled={selectedKeys.length === 0}>
              清空
            </Button>
          </Space>

          <div
            style={{
              maxHeight: hasImportModeSelector ? '52vh' : 'none',
              overflowY: hasImportModeSelector ? 'auto' : 'visible',
              paddingRight: hasImportModeSelector ? 4 : 0,
            }}
          >
            <Checkbox.Group
              style={{ width: '100%' }}
              value={selectedKeys}
              onChange={(values) =>
                onChange(values.filter((value): value is ConfigExportSectionId => typeof value === 'string'))
              }
            >
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {groupedOptions.map((group, groupIndex) => (
                  <div key={group.key}>
                    {groupIndex > 0 ? <Divider style={{ margin: '4px 0 12px' }} /> : null}
                    <Text strong style={{ display: 'block', marginBottom: 10 }}>
                      {group.label}
                    </Text>
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      {group.items.map((option) => (
                        <div
                          key={option.key}
                          style={{
                            padding: '10px 12px',
                            border: '1px solid rgba(255, 255, 255, 0.08)',
                            borderRadius: 8,
                            opacity: option.disabled ? 0.55 : 1,
                          }}
                        >
                          <Checkbox value={option.key} disabled={option.disabled}>
                            {option.label}
                          </Checkbox>
                          <div style={{ marginTop: 6, marginLeft: 24 }}>
                            <Text type="secondary">{option.description}</Text>
                          </div>
                        </div>
                      ))}
                    </Space>
                  </div>
                ))}
              </Space>
            </Checkbox.Group>
          </div>

          {extra ? <div style={{ marginTop: 16 }}>{extra}</div> : null}
        </div>
      </div>
    </Modal>
  );
};

export default ConfigSectionPickerModal;
