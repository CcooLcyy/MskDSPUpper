import React from 'react';
import { useSearchParams } from 'react-router-dom';
import AGC from '../AGC';
import AVC from '../AVC';
import { CONTROL_MODULE_QUERY_KEY, normalizeControlModule } from '../../components/control/control-module';
import './index.css';

const Control: React.FC = () => {
  const [searchParams] = useSearchParams();
  const module = normalizeControlModule(searchParams.get(CONTROL_MODULE_QUERY_KEY));

  return (
    <div className="control-page">
      <div className="control-page-content">
        {module === 'avc' ? <AVC /> : <AGC />}
      </div>
    </div>
  );
};

export default Control;
