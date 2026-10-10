import { useState } from 'react';
import { Alert, Button, message } from 'antd';
import { api } from '../../adapters';
import { ControlGroupRoutesError, retryControlRoutes } from '../../utils/control-auto-routing';
import { formatErrorText } from '../../utils/runtime-restart';

/** 保留部分成功操作的路由计划，仅重试 DataCenter 映射同步。 */
export default function ControlRouteRetry({ error, onComplete, onFailure }: { error: ControlGroupRoutesError | null; onComplete: () => void; onFailure: (error: ControlGroupRoutesError) => void }) {
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [messageApi, contextHolder] = message.useMessage();
  if (!error) return null;
  const groups = [...new Set([...error.routes, ...error.removedRoutes].flatMap((route) => [route.src, route.dst])
    .filter((endpoint) => endpoint.module_name === 'AGC' || endpoint.module_name === 'AVC')
    .map((endpoint) => `${endpoint.module_name} / ${endpoint.conn_name}`))].join('，');
  const retry = async () => {
    setBusy(true);
    setRetryError(null);
    try {
      await retryControlRoutes(error, { saveRoutes: (routes) => api.dcUpsertRoutes(routes, false), deleteRoutes: (routes) => api.dcDeleteRoutes(routes) });
      messageApi.success('待处理映射已同步，控制组配置未重复保存');
      onComplete();
    } catch (failure) {
      if (failure instanceof ControlGroupRoutesError) onFailure(failure);
      else setRetryError(formatErrorText(failure));
      console.error('重试控制组映射失败', { 错误: failure });
    } finally { setBusy(false); }
  };
  return <>
    {contextHolder}
    <Alert type="error" showIcon style={{ marginBottom: 12 }} title="控制组配置已保存，映射尚未同步完成"
      description={`${groups}：待新增/确认 ${error.routes.length} 条，待解除 ${error.removedRoutes.length} 条。${error.phase === 'delete' ? '新映射已提交，旧映射清理失败。' : '新增映射失败，旧映射未清理。'}${retryError ?? formatErrorText(error.routeError)}`}
      action={<Button loading={busy} onClick={() => void retry()}>仅重试映射</Button>} />
  </>;
}
