import { App, Alert, Button, Descriptions, Input, Modal, Progress, Space, Tag, Typography } from 'antd';
import {
  CheckCircleOutlined,
  CloudUploadOutlined,
  LoadingOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  UploadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useLowerUpdateDeployment } from './lower-update-deployment-context';

const { Text } = Typography;
type DeploymentTask = NonNullable<ReturnType<typeof useLowerUpdateDeployment>['task']>;

const STAGE_LABELS: Record<DeploymentTask['stage'], string> = {
  checking: '下发前检查中',
  uploading: '上传中',
  installing: '安装中',
  verifying: '镜像确认中',
  cleaning: '历史包清理中',
  succeeded: '更新完成',
  check_failed: '下发前检查失败',
  upload_failed: '上传失败',
  install_failed: '安装失败',
  verify_failed: '镜像确认失败',
  image_mismatch: '构建不一致',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 || value >= 10 ? 0 : 1)} ${units[index]}`;
}

function getResultTitle(task: DeploymentTask): string {
  if (task.stage !== 'succeeded') {
    return task.stage === 'verify_failed' || task.stage === 'image_mismatch'
      ? '下位机更新未确认成功'
      : '下位机更新失败';
  }
  if (task.cleanupError) return '下位机更新完成，历史包清理失败';
  return task.alreadyCurrent ? '下位机已是指定版本' : '下位机更新完成';
}

export function LowerUpdateDeploymentHeader() {
  const { task, isRunning, openDetails } = useLowerUpdateDeployment();
  if (!task) return null;
  const succeeded = task.stage === 'succeeded';
  const icon = isRunning
    ? <LoadingOutlined />
    : succeeded && !task.cleanupError
      ? <CheckCircleOutlined />
      : <WarningOutlined />;
  const label = task.cleanupError && succeeded ? '更新完成，清理失败'
    : task.alreadyCurrent && succeeded ? '已是指定版本' : STAGE_LABELS[task.stage];

  return (
    <Button size="small" icon={icon} onClick={openDetails} title={`目标下位机：${task.uploadAccount}`}>
      下位机更新 · {label}
    </Button>
  );
}

export function LowerUpdateDeploymentUi() {
  const { message } = App.useApp();
  const { task, isRunning, detailOpen, resultOpen, retry, openDetails, closeDetails, dismissResult } =
    useLowerUpdateDeployment();
  if (!task) return null;

  const succeeded = task.stage === 'succeeded';
  const failed = !isRunning && !succeeded;
  const statusColor = isRunning ? 'processing' : succeeded ? task.cleanupError ? 'warning' : 'success' : 'error';
  const retryTask = async (mode: 'retry' | 'reupload' | 'reinstall' | 'reverify') => {
    try {
      await retry(mode);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : String(error));
    }
  };
  const uploadStatus = task.stage === 'uploading'
    ? '上传中'
    : task.stage === 'upload_failed'
      ? '上传失败'
      : task.uploadResult ? '上传完成' : task.alreadyCurrent ? '已跳过' : '未执行';
  const installStatus = task.stage === 'installing'
    ? '执行中'
    : task.stage === 'install_failed'
      ? '执行失败'
      : task.installResult
        ? task.installResult.success ? '执行成功' : '执行失败'
        : task.alreadyCurrent ? '已跳过' : '未执行';
  const verificationStatus = task.stage === 'verifying'
    ? '确认中'
    : succeeded || task.stage === 'cleaning'
      ? '确认成功'
      : task.stage === 'image_mismatch'
        ? '构建不一致'
        : task.stage === 'verify_failed' ? '确认失败' : '待确认';
  const wrapStyle = { overflowWrap: 'anywhere' as const, minWidth: 0 };

  return (
    <>
      <Modal
        open={detailOpen}
        title="下发并安装"
        width={620}
        onCancel={closeDetails}
        onOk={closeDetails}
        okText={isRunning ? '后台执行' : '关闭'}
        cancelButtonProps={{ style: { display: 'none' } }}
        mask={{ closable: true }}
        styles={{ body: { maxHeight: '72vh', overflowY: 'auto' } }}
      >
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          {isRunning ? (
            <Alert type="info" showIcon icon={<CloudUploadOutlined />} title="收起窗口或切换页面后，任务会继续执行。请保持上位机运行。" />
          ) : null}
          <Descriptions size="small" column={1} styles={{ content: wrapStyle }}>
            <Descriptions.Item label="目标下位机">{task.uploadAccount}</Descriptions.Item>
            <Descriptions.Item label="目标版本">{task.version}</Descriptions.Item>
            <Descriptions.Item label="SSH 认证方式">{task.authMethod === 'password' ? '密码' : '证书'}</Descriptions.Item>
            <Descriptions.Item label="安装目录">{task.installDir}</Descriptions.Item>
            <Descriptions.Item label="安装包">{task.packageName}</Descriptions.Item>
            <Descriptions.Item label="本地路径">{task.packagePath}</Descriptions.Item>
            <Descriptions.Item label="远端路径">{task.remotePath || '-'}</Descriptions.Item>
            <Descriptions.Item label="已上传">{formatBytes(task.uploadedBytes)} / {formatBytes(task.totalBytes)}</Descriptions.Item>
            <Descriptions.Item label="任务阶段"><Tag color={statusColor}>{STAGE_LABELS[task.stage]}</Tag></Descriptions.Item>
            <Descriptions.Item label="上传状态">{uploadStatus}</Descriptions.Item>
            <Descriptions.Item label="安装状态">{installStatus}</Descriptions.Item>
            <Descriptions.Item label="确认目标">mskdsp 容器</Descriptions.Item>
            <Descriptions.Item label="期望镜像 ID">{task.expectedImageId || '-'}</Descriptions.Item>
            <Descriptions.Item label="实际镜像 ID">{task.actualImageId || '-'}</Descriptions.Item>
            <Descriptions.Item label="确认状态">{verificationStatus}</Descriptions.Item>
            <Descriptions.Item label="确认说明">{task.verificationMessage || '-'}</Descriptions.Item>
            <Descriptions.Item label="历史包清理">{task.cleanupMessage || '未执行'}</Descriptions.Item>
            <Descriptions.Item label="退出码">{task.installResult?.exit_code ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="执行命令"><Text code style={wrapStyle}>{task.installResult?.command || '-'}</Text></Descriptions.Item>
          </Descriptions>
          <Progress percent={task.progress} status={failed ? 'exception' : succeeded ? 'success' : 'active'} />
          {task.error ? <Alert type="error" showIcon title={task.error} style={wrapStyle} /> : null}
          {task.cleanupError ? <Alert type="warning" showIcon title="更新已确认成功，历史包清理失败" description={task.cleanupError} style={wrapStyle} /> : null}
          {task.connectionWarning ? <Alert type="warning" showIcon title={task.connectionWarning} style={wrapStyle} /> : null}
          <Space wrap>
            <Button size="small" icon={<ReloadOutlined />} disabled={!failed || isRunning} onClick={() => void retryTask('retry')}>重试流程</Button>
            <Button size="small" icon={<UploadOutlined />} disabled={isRunning} onClick={() => void retryTask('reupload')}>重新上传并安装</Button>
            <Button size="small" icon={<ReloadOutlined />} disabled={!task.uploadResult || isRunning} onClick={() => void retryTask('reinstall')}>重新安装</Button>
            <Button size="small" icon={<SafetyCertificateOutlined />} disabled={!task.installResult?.success || isRunning} onClick={() => void retryTask('reverify')}>重新确认镜像</Button>
          </Space>
          <div style={{ width: '100%' }}>
            <Text type="secondary">安装输出</Text>
            <Input.TextArea aria-label="安装标准输出" value={task.installResult?.stdout || '-'} readOnly autoSize={{ minRows: 2, maxRows: 6 }} />
          </div>
          <div style={{ width: '100%' }}>
            <Text type="secondary">错误输出</Text>
            <Input.TextArea aria-label="安装错误输出" value={task.installResult?.stderr || '-'} readOnly autoSize={{ minRows: 2, maxRows: 4 }} />
          </div>
          <Text type="secondary">安装命令成功并确认运行镜像后，会清理设备上的历史安装包，保留本次安装包；安装或镜像确认失败时保留所有包。</Text>
        </Space>
      </Modal>
      <Modal
        open={resultOpen}
        title={getResultTitle(task)}
        onCancel={dismissResult}
        footer={[
          <Button key="close" onClick={dismissResult}>关闭</Button>,
          <Button key="details" type="primary" onClick={openDetails}>查看详情</Button>,
        ]}
      >
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type={succeeded ? task.cleanupError ? 'warning' : 'success' : 'error'}
            showIcon
            title={task.alreadyCurrent && succeeded ? '目标下位机已运行指定构建，已跳过重复上传和安装。' : STAGE_LABELS[task.stage]}
          />
          <Descriptions size="small" column={1} styles={{ content: wrapStyle }}>
            <Descriptions.Item label="目标下位机">{task.uploadAccount}</Descriptions.Item>
            <Descriptions.Item label="目标版本">{task.version}</Descriptions.Item>
            <Descriptions.Item label="镜像确认">{task.verificationMessage || verificationStatus}</Descriptions.Item>
            <Descriptions.Item label="历史包清理">{task.cleanupMessage || '未执行'}</Descriptions.Item>
          </Descriptions>
          {task.error ? <Alert type="error" title={task.error} style={wrapStyle} /> : null}
          {task.cleanupError ? <Alert type="warning" title={task.cleanupError} style={wrapStyle} /> : null}
          {task.connectionWarning ? <Alert type="warning" title={task.connectionWarning} style={wrapStyle} /> : null}
        </Space>
      </Modal>
    </>
  );
}
