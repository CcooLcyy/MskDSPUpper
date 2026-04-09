import React from 'react';
import { Tabs } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  createProtocolViewSearch,
  normalizeProtocolView,
  PROTOCOL_VIEW_QUERY_KEY,
  PROTOCOL_VIEW_OPTIONS,
} from './protocol-view';

const ProtocolHeaderViewSwitcher: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const value = normalizeProtocolView(new URLSearchParams(location.search).get(PROTOCOL_VIEW_QUERY_KEY));

  const handleChange = (nextValue: string | number) => {
    const nextView = normalizeProtocolView(String(nextValue));
    const nextSearch = createProtocolViewSearch(location.search, nextView);

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

  return (
    <div className="protocol-header-view-switcher" aria-label="协议页面切换">
      <Tabs
        className="protocol-header-tabs"
        activeKey={value}
        animated={false}
        items={PROTOCOL_VIEW_OPTIONS.map((option) => ({
          key: option.value,
          label: option.label,
          children: null,
        }))}
        onChange={handleChange}
      />
    </div>
  );
};

export default ProtocolHeaderViewSwitcher;
