import { Card, Typography } from 'antd';
import { SOFTWARE_PLATFORM_ENDPOINT } from '../../../utils/software-platform';

export default function SoftwarePlatformSettings() {
  return <Card title="软件平台" size="small" bordered>
    <Typography.Paragraph type="secondary">
      上位机和下位机安装包均从此平台获取。
    </Typography.Paragraph>
    <Typography.Text code>{SOFTWARE_PLATFORM_ENDPOINT}</Typography.Text>
  </Card>;
}
