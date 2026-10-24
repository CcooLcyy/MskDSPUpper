import React from 'react';
import { Tabs } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  createProtocolViewSearch,
  normalizeProtocolView,
  PROTOCOL_VIEW_QUERY_KEY,
  PROTOCOL_VIEW_OPTIONS,
} from './protocol-view';

interface ProtocolHeaderViewSwitcherProps {
  includeSoe?: boolean;
}

const ProtocolHeaderViewSwitcher: React.FC<ProtocolHeaderViewSwitcherProps> = ({ includeSoe = false }) => {
  const location = useLocation();
  const navigate = useNavigate();

  const value = normalizeProtocolView(new URLSearchParams(location.search).get(PROTOCOL_VIEW_QUERY_KEY), includeSoe);

  const handleChange = (nextValue: string | number) => {
    const nextView = normalizeProtocolView(String(nextValue), includeSoe);
    const nextSearch = createProtocolViewSearch(location.search, nextView);

    if (nextSearch === location.search) {
      return;
    }

    console.info('协议页签已切换', { view: nextView });
    navigate(
      {
        pathname: location.pathname,
        search: nextSearch,
      },
      { replace: true },
    );
  };

  const options = includeSoe
    ? PROTOCOL_VIEW_OPTIONS
    : PROTOCOL_VIEW_OPTIONS.filter((option) => option.value !== 'soe');

  return (
    <div className="protocol-header-view-switcher" aria-label="协议页面切换">
      <Tabs
        className="app-view-tabs protocol-header-tabs"
        activeKey={value}
        animated={false}
        items={options.map((option) => ({
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
