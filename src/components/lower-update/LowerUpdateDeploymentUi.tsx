import { useState } from 'react';
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
  remote_unknown: '暂时无法确认更新结果',
  waiting_reconnect: '等待设备重新上线',
  rolling_back: '正在自动回退',
  rolled_back: '更新失败，已自动恢复上一版本',
  rollback_failed: '自动回退失败，需要人工处理',
  checking: '下发前检查中',
  uploading: '上传中',
  installing: '安装中',
  verifying: '镜像确认中',
  cleaning: '历史包清理中',
  reconnecting: '恢复业务连接中',
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
  if (task.stage === 'remote_unknown') return '下位机更新结果待确认';
  if (task.stage === 'rolled_back') return '更新失败，已自动恢复上一版本';
  if (task.stage === 'rollback_failed') return '自动回退失败，需要人工处理';
  if (task.stage !== 'succeeded') {
    return task.stage === 'verify_failed' || task.stage === 'image_mismatch'
      ? '下位机更新未确认成功'
      : '下位机更新失败';
  }
  if (task.runtimeRefreshError) return '下位机更新完成，业务连接恢复失败';
  if (task.cleanupError) return '下位机更新完成，历史包清理失败';
  return task.alreadyCurrent ? '下位机已是指定版本' : '下位机更新完成';
}

export function LowerUpdateDeploymentHeader() {
  const { task, isRunning, openDetails } = useLowerUpdateDeployment();
  if (!task) return null;
  const succeeded = task.stage === 'succeeded';
  const icon = isRunning
    ? <LoadingOutlined />
    : succeeded && !task.cleanupError && !task.runtimeRefreshError
      ? <CheckCircleOutlined />
      : <WarningOutlined />;
  const label = task.runtimeRefreshError && succeeded ? '更新完成，连接待恢复'
    : task.cleanupError && succeeded ? '更新完成，清理失败'
    : task.alreadyCurrent && succeeded ? '已是指定版本' : STAGE_LABELS[task.stage];

  return (
    <Button size="small" icon={icon} onClick={openDetails} title={`目标下位机：${task.remoteTarget ? `${task.remoteTarget.device_id} · ${task.remoteTarget.endpoint}` : task.uploadAccount}`}>
      下位机更新 · {label}
    </Button>
  );
}

export function LowerUpdateDeploymentUi() {
  const { message } = App.useApp();
  const [sshPassword, setSshPassword] = useState('');
  const [sudoPassword, setSudoPassword] = useState('');
  const { task, isRunning, detailOpen, resultOpen, retry, resumeRemote, openDetails, closeDetails, dismissResult } =
    useLowerUpdateDeployment();
  if (!task) return null;

  const succeeded = task.stage === 'succeeded';
  const uncertain = task.stage === 'remote_unknown';
  const failed = !isRunning && !succeeded && !uncertain;
  const hasWarning = Boolean(task.cleanupError || task.runtimeRefreshError);
  const statusColor = uncertain ? 'warning' : isRunning ? 'processing' : succeeded ? hasWarning ? 'warning' : 'success' : 'error';
  const retryTask = async (mode: 'retry' | 'reupload' | 'reinstall' | 'reverify' | 'reconnect') => {
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
        : task.remoteTarget && task.operationId ? '由宿主机独立执行' : task.alreadyCurrent ? '已跳过' : '未执行';
  const verificationStatus = task.stage === 'verifying'
    ? '确认中'
    : succeeded || task.stage === 'cleaning' || task.stage === 'reconnecting'
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
            <Alert type="info" showIcon icon={<CloudUploadOutlined />} title={task.remoteTarget ? '宿主机任务已提交后，断线或关闭上位机不影响执行；重新打开可恢复查询。' : '收起窗口或切换页面后，任务会继续执行。请保持上位机运行。'} />
          ) : null}
          <Descriptions size="small" column={1} styles={{ content: wrapStyle }}>
            <Descriptions.Item label="目标下位机">{task.remoteTarget ? `${task.remoteTarget.device_id} · ${task.remoteTarget.endpoint} · ${task.uploadAccount.split('@')[0]}` : task.uploadAccount}</Descriptions.Item>
            <Descriptions.Item label="目标版本">{task.version}</Descriptions.Item>
            <Descriptions.Item label="SSH 认证方式">{task.authMethod === 'password' ? '密码' : '证书'}</Descriptions.Item>
            <Descriptions.Item label="安装目录">{task.installDir}</Descriptions.Item>
            <Descriptions.Item label="安装包">{task.packageName}</Descriptions.Item>
            <Descriptions.Item label="本地路径">{task.packagePath}</Descriptions.Item>
            <Descriptions.Item label="远端路径">{task.remotePath || '-'}</Descriptions.Item>
            <Descriptions.Item label="已上传">{formatBytes(task.uploadedBytes)} / {formatBytes(task.totalBytes)}</Descriptions.Item>
            {task.operationId ? <Descriptions.Item label="宿主机任务编号">{task.operationId}</Descriptions.Item> : null}
            <Descriptions.Item label="任务阶段"><Tag color={statusColor}>{STAGE_LABELS[task.stage]}</Tag></Descriptions.Item>
            <Descriptions.Item label="上传状态">{uploadStatus}</Descriptions.Item>
            <Descriptions.Item label="安装状态">{installStatus}</Descriptions.Item>
            <Descriptions.Item label="确认目标">mskdsp 容器</Descriptions.Item>
            <Descriptions.Item label="期望镜像 ID">{task.expectedImageId || '-'}</Descriptions.Item>
            <Descriptions.Item label="实际镜像 ID">{task.actualImageId || '-'}</Descriptions.Item>
            <Descriptions.Item label="确认状态">{verificationStatus}</Descriptions.Item>
            <Descriptions.Item label="确认说明">{task.verificationMessage || '-'}</Descriptions.Item>
            <Descriptions.Item label="历史包清理">{task.cleanupMessage || '未执行'}</Descriptions.Item>
            <Descriptions.Item label="业务连接">{task.runtimeRefreshMessage || '未执行'}</Descriptions.Item>
            <Descriptions.Item label="退出码">{task.taskExitCode ?? task.installResult?.exit_code ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="执行命令"><Text code style={wrapStyle}>{task.installResult?.command || '-'}</Text></Descriptions.Item>
          </Descriptions>
          <Progress percent={task.progress} status={uncertain ? 'normal' : failed ? 'exception' : succeeded ? 'success' : 'active'} />
          {task.error ? <Alert type="error" showIcon title={task.error} style={wrapStyle} /> : null}
          {task.cleanupError ? <Alert type="warning" showIcon title="更新已确认成功，历史包清理失败" description={task.cleanupError} style={wrapStyle} /> : null}
          {task.runtimeRefreshError ? <Alert type="warning" showIcon title="更新已确认成功，业务连接尚未恢复" description={task.runtimeRefreshError} style={wrapStyle} /> : null}
          {task.connectionWarning ? <Alert type="warning" showIcon title={task.connectionWarning} style={wrapStyle} /> : null}
          {succeeded && task.runtimeRefreshError ? <Button size="small" icon={<ReloadOutlined />} disabled={isRunning} onClick={() => void retryTask('reconnect')}>只重试业务连接</Button> : null}
          {task.remoteTarget && (task.stage === 'remote_unknown' || task.stage === 'rollback_failed') ? (
            <Space orientation="vertical" style={{ width: '100%' }}>
              <Alert type="warning" title={task.stage === 'rollback_failed' ? '自动回退失败，原任务和恢复材料已保留。请人工检查设备后查询原任务，不能继续新建更新。' : '结果尚未确认，请查询原任务；不要重复安装。首次连接请先在远程 SSH 终端确认设备指纹。'} />
              <Input.Password aria-label="恢复查询 SSH 密码" placeholder="重新输入原设备 SSH 密码" value={sshPassword} onChange={event => setSshPassword(event.target.value)} />
              <Input.Password aria-label="恢复查询 sudo 密码" placeholder="重新输入原设备 sudo 密码" value={sudoPassword} onChange={event => setSudoPassword(event.target.value)} />
              <Button disabled={isRunning || !sshPassword || !sudoPassword} onClick={() => {
                const auth = { method: 'password' as const, password: sshPassword };
                const sudo = sudoPassword; setSshPassword(''); setSudoPassword('');
                void resumeRemote(auth, sudo).catch(error => message.error(String(error)));
              }}>恢复查询原任务</Button>
            </Space>
          ) : null}
          {!task.remoteTarget ? <Space wrap>
            <Button size="small" icon={<ReloadOutlined />} disabled={!failed || isRunning} onClick={() => void retryTask('retry')}>重试流程</Button>
            <Button size="small" icon={<UploadOutlined />} disabled={isRunning} onClick={() => void retryTask('reupload')}>重新上传并安装</Button>
            <Button size="small" icon={<ReloadOutlined />} disabled={!task.uploadResult || isRunning} onClick={() => void retryTask('reinstall')}>重新安装</Button>
            <Button size="small" icon={<SafetyCertificateOutlined />} disabled={!task.installResult?.success || isRunning} onClick={() => void retryTask('reverify')}>重新确认镜像</Button>
          </Space> : null}
          <div style={{ width: '100%' }}>
            <Text type="secondary">安装输出</Text>
            <Input.TextArea aria-label="安装标准输出" value={task.taskLog || task.installResult?.stdout || '-'} readOnly autoSize={{ minRows: 2, maxRows: 6 }} />
          </div>
          <div style={{ width: '100%' }}>
            <Text type="secondary">错误输出</Text>
            <Input.TextArea aria-label="安装错误输出" value={task.installResult?.stderr || '-'} readOnly autoSize={{ minRows: 2, maxRows: 4 }} />
          </div>
          <Text type="secondary">{task.remoteTarget ? '宿主机独立检查运行状态，失败时自动回退；稳定状态保留当前版本与一个先前版本。回退失败保留恢复材料。' : '安装命令成功并确认运行镜像后，会清理设备上的历史安装包，保留本次安装包；安装或镜像确认失败时保留所有包。'}</Text>
        </Space>
      </Modal>
      <Modal
        open={resultOpen}
        title={getResultTitle(task)}
        onCancel={dismissResult}
        footer={[
          succeeded && task.runtimeRefreshError ? <Button key="reconnect" icon={<ReloadOutlined />} disabled={isRunning} onClick={() => void retryTask('reconnect')}>只重试业务连接</Button> : null,
          <Button key="close" onClick={dismissResult}>关闭</Button>,
          <Button key="details" type="primary" onClick={openDetails}>查看详情</Button>,
        ]}
      >
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type={uncertain ? 'warning' : succeeded ? hasWarning ? 'warning' : 'success' : 'error'}
            showIcon
            title={task.alreadyCurrent && succeeded ? '目标下位机已运行指定构建，已跳过重复上传和安装。' : STAGE_LABELS[task.stage]}
          />
          <Descriptions size="small" column={1} styles={{ content: wrapStyle }}>
            <Descriptions.Item label="目标下位机">{task.remoteTarget ? `${task.remoteTarget.device_id} · ${task.remoteTarget.endpoint} · ${task.uploadAccount.split('@')[0]}` : task.uploadAccount}</Descriptions.Item>
            <Descriptions.Item label="目标版本">{task.version}</Descriptions.Item>
            <Descriptions.Item label="镜像确认">{task.verificationMessage || verificationStatus}</Descriptions.Item>
            <Descriptions.Item label="历史包清理">{task.cleanupMessage || '未执行'}</Descriptions.Item>
            <Descriptions.Item label="业务连接">{task.runtimeRefreshMessage || '未执行'}</Descriptions.Item>
          </Descriptions>
          {task.error ? <Alert type="error" title={task.error} style={wrapStyle} /> : null}
          {task.cleanupError ? <Alert type="warning" title={task.cleanupError} style={wrapStyle} /> : null}
          {task.runtimeRefreshError ? <Alert type="warning" title="更新已确认成功，业务连接尚未恢复" description={task.runtimeRefreshError} style={wrapStyle} /> : null}
          {task.connectionWarning ? <Alert type="warning" title={task.connectionWarning} style={wrapStyle} /> : null}
        </Space>
      </Modal>
    </>
  );
}
