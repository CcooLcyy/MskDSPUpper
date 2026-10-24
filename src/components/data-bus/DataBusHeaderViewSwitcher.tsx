import React from 'react';
import { Tabs } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  createDataBusViewSearch,
  DATA_BUS_VIEW_OPTIONS,
  normalizeDataBusView,
} from './data-bus-view';
import { useWorkbench } from '../../workbench/workbench-context';
import { dataBusViewForWorkbench } from '../control/workbench-control';
import { useAppMode } from '../../offline/app-mode-context';

const DataBusHeaderViewSwitcher: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { view, setView } = useWorkbench();
  const { can } = useAppMode();
  const value = dataBusViewForWorkbench(view);

  const handleChange = (nextValue: string | number) => {
    const nextDataBusView = normalizeDataBusView(String(nextValue));
    setView(nextDataBusView === 'monitor' ? 'runtime' : 'engineering');
    // 显式页签导航保留在地址中；全局工作视图切换不触发导航。
    const nextParams = new URLSearchParams(createDataBusViewSearch(location.search, nextDataBusView));
    nextParams.set('view', nextDataBusView);
    const nextSearch = `?${nextParams.toString()}`;
    if (nextSearch === location.search) {
      return;
    }

    navigate({ pathname: location.pathname, search: nextSearch }, { replace: true });
  };

  return (
    <div className="protocol-header-view-switcher" aria-label="数据总线页面切换">
      <Tabs
        className="app-view-tabs protocol-header-tabs"
        activeKey={value}
        animated={false}
        items={DATA_BUS_VIEW_OPTIONS.map((option) => ({
          key: option.value,
          label: option.label,
          disabled: option.value === 'monitor' && !can('runtime.control'),
          children: null,
        }))}
        onChange={handleChange}
      />
    </div>
  );
};

export default DataBusHeaderViewSwitcher;
