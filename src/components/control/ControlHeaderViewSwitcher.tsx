import React from 'react';
import { Tabs } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  CONTROL_VIEW_OPTIONS,
  CONTROL_VIEW_QUERY_KEY,
  createControlViewSearch,
  normalizeControlView,
} from './control-view';
import {
  CONTROL_MODULE_OPTIONS,
  CONTROL_MODULE_QUERY_KEY,
  createControlModuleSearch,
  normalizeControlModule,
} from './control-module';

const ControlHeaderViewSwitcher: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const value = normalizeControlView(new URLSearchParams(location.search).get(CONTROL_VIEW_QUERY_KEY));
  const module = normalizeControlModule(new URLSearchParams(location.search).get(CONTROL_MODULE_QUERY_KEY));

  const handleChange = (nextValue: string | number) => {
    const nextView = normalizeControlView(String(nextValue));
    const nextSearch = createControlViewSearch(location.search, nextView);

    if (nextSearch === location.search) {
      return;
    }

    navigate(
      {
        pathname: location.pathname,
        search: nextSearch,
      },
      { replace: true },
    );
  };

  const handleModuleChange = (nextValue: string | number) => {
    const nextSearch = createControlModuleSearch(location.search, normalizeControlModule(String(nextValue)));

    if (nextSearch !== location.search) {
      navigate({ pathname: location.pathname, search: nextSearch }, { replace: true });
    }
  };

  return (
    <div className="protocol-header-view-switcher control-header-view-switcher" aria-label="控制页面切换">
      <Tabs
        className="app-view-tabs protocol-header-tabs"
        activeKey={module}
        animated={false}
        items={CONTROL_MODULE_OPTIONS.map((option) => ({
          key: option.value,
          label: option.label,
          children: null,
        }))}
        onChange={handleModuleChange}
      />
      <span className="protocol-header-tabs-divider" aria-hidden="true" />
      <Tabs
        className="app-view-tabs protocol-header-tabs"
        activeKey={value}
        animated={false}
        items={CONTROL_VIEW_OPTIONS.map((option) => ({
          key: option.value,
          label: option.label,
          children: null,
        }))}
        onChange={handleChange}
      />
    </div>
  );
};

export default ControlHeaderViewSwitcher;
