import React from 'react';
import { Tabs } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  createDataBusViewSearch,
  DATA_BUS_VIEW_OPTIONS,
  DATA_BUS_VIEW_QUERY_KEY,
  normalizeDataBusView,
} from './data-bus-view';

const DataBusHeaderViewSwitcher: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const value = normalizeDataBusView(new URLSearchParams(location.search).get(DATA_BUS_VIEW_QUERY_KEY));

  const handleChange = (nextValue: string | number) => {
    const nextSearch = createDataBusViewSearch(location.search, normalizeDataBusView(String(nextValue)));
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
          children: null,
        }))}
        onChange={handleChange}
      />
    </div>
  );
};

export default DataBusHeaderViewSwitcher;
