import React, { useState } from 'react';
import { Button, Form, Input, Typography } from 'antd';
import {
  authorizeAdvancedConfigSession,
  isAdvancedConfigAuthorized,
  isAdvancedConfigPasswordValid,
} from '../../utils/advanced-config-auth';

const { Text } = Typography;

type AdvancedConfigAuthFormValues = {
  password: string;
};

const AdvancedConfigPage: React.FC = () => {
  const [authorized, setAuthorized] = useState(isAdvancedConfigAuthorized);
  const [form] = Form.useForm<AdvancedConfigAuthFormValues>();

  const handleSubmit = ({ password }: AdvancedConfigAuthFormValues): void => {
    if (!isAdvancedConfigPasswordValid(password)) {
      form.setFields([{ name: 'password', errors: ['密码不正确'] }]);
      return;
    }

    authorizeAdvancedConfigSession();
    setAuthorized(true);
    form.resetFields();
  };

  if (authorized) {
    return (
      <div style={{ color: '#aaa', fontSize: 16, padding: 40, textAlign: 'center' }}>
        {'\u9ad8\u7ea7\u914d\u7f6e\u529f\u80fd\u5f00\u53d1\u4e2d'}
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{ width: 360, maxWidth: '100%' }}>
        <Text strong style={{ display: 'block', color: '#fff', fontSize: 16, marginBottom: 16 }}>
          高级配置验证
        </Text>
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password autoFocus autoComplete="current-password" placeholder="请输入密码" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            进入
          </Button>
        </Form>
      </div>
    </div>
  );
};

export default AdvancedConfigPage;
