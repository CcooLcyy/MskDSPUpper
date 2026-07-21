import React from 'react';
import { Tabs } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  createSoftwareUpdateViewSearch,
  normalizeSoftwareUpdateView,
  SOFTWARE_UPDATE_VIEW_OPTIONS,
  SOFTWARE_UPDATE_VIEW_QUERY_KEY,
} from './update-view';

const SoftwareUpdateHeaderViewSwitcher: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const value = normalizeSoftwareUpdateView(new URLSearchParams(location.search).get(SOFTWARE_UPDATE_VIEW_QUERY_KEY));

  const handleChange = (nextValue: string | number) => {
    const nextSearch = createSoftwareUpdateViewSearch(location.search, normalizeSoftwareUpdateView(String(nextValue)));
    if (nextSearch === location.search) {
      return;
    }

    navigate({ pathname: location.pathname, search: nextSearch }, { replace: true });
  };

  return (
    <div className="protocol-header-view-switcher" aria-label="软件更新页面切换">
      <Tabs
        className="app-view-tabs protocol-header-tabs"
        activeKey={value}
        animated={false}
        items={SOFTWARE_UPDATE_VIEW_OPTIONS.map((option) => ({
          key: option.value,
          label: option.label,
          children: null,
        }))}
        onChange={handleChange}
      />
    </div>
  );
};

export default SoftwareUpdateHeaderViewSwitcher;
