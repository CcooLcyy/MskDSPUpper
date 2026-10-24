import { Segmented, Tooltip } from 'antd';
import { EditOutlined, FundProjectionScreenOutlined } from '@ant-design/icons';
import { useWorkbench } from './workbench-context';
import type { WorkbenchView } from './workbench-view';

export function WorkbenchViewSwitcher() {
  const { view, setView, runtimeAvailable } = useWorkbench();
  return (
    <Tooltip title={runtimeAvailable ? '切换工作视图会保留当前对象与编辑草稿' : '离线工作区只支持工程配置，返回在线后恢复上次视图'}>
      <div className="workbench-view-switcher" aria-label="工作视图">
        <Segmented<WorkbenchView>
          aria-label="工作视图切换"
          value={view}
          onChange={setView}
          options={[
            { label: '工程配置', value: 'engineering', icon: <EditOutlined /> },
            { label: '运行监视', value: 'runtime', icon: <FundProjectionScreenOutlined />, disabled: !runtimeAvailable },
          ]}
        />
      </div>
    </Tooltip>
  );
}
