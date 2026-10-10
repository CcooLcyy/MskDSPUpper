import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../adapters';
import type { DcEndpoint, DcRoute } from '../../adapters';
import type { ControlDataBusBinding } from '../../utils/control-auto-routing';
import { buildControlMappingPlan, controlEndpointKey, controlMappingFieldKey, getControlMappingEndpoints } from '../../utils/control-mapping-editor';
import type { ControlMappingField } from '../../utils/control-mapping-editor';
import { formatErrorText } from '../../utils/runtime-restart';

export default function useControlMappings(moduleName: 'AGC' | 'AVC') {
  const [groupName, setGroupName] = useState('');
  const [routes, setRoutes] = useState<DcRoute[]>([]);
  const [options, setOptions] = useState<Array<{ value: string; label: string; endpoint: DcEndpoint }>>([]);
  const [edited, setEdited] = useState<Record<string, DcEndpoint[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const requestRef = useRef(0);
  const initializedRef = useRef(false);
  const editedRef = useRef(edited);

  useEffect(() => () => { requestRef.current += 1; }, []);

  const load = useCallback(async (nextGroupName: string, reset: boolean) => {
    const request = ++requestRef.current;
    setGroupName(nextGroupName);
    setLoading(true);
    setError(null);
    setWarning(null);
    if (reset) {
      initializedRef.current = false;
      editedRef.current = {};
      setEdited({});
      setRoutes([]);
      setOptions([]);
    }
    try {
      const [connections, existingRoutes] = await Promise.all([
        api.dcListConnections(), api.dcListRoutes(0, '', 0, ''),
      ]);
      const tagResults = await Promise.allSettled(connections
        .filter((connection) => connection.module_name !== moduleName || connection.conn_name !== nextGroupName)
        .map(async (connection) => {
          const tags = await api.dcGetConnTags(connection.conn_id);
          return tags.tags.map((tag) => {
            const endpoint = { module_name: connection.module_name, conn_name: connection.conn_name, tag };
            return { value: controlEndpointKey(endpoint), label: `${connection.module_name} / ${connection.conn_name} / ${tag}`, endpoint };
          });
        }));
      if (request !== requestRef.current) return;
      setOptions(tagResults.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
        .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN')));
      const failures = tagResults.filter((result) => result.status === 'rejected');
      if (failures.length > 0) {
        setWarning(`${failures.length} 个连接的点位加载失败，可刷新重试；已有映射仍完整显示。`);
        console.warn('控制组部分外部点位加载失败', { 模块: moduleName, 控制组: nextGroupName, 失败数量: failures.length });
      }
      // 编辑期间刷新选项不扩大待删除基线，避免清理用户尚未看过的新路由。
      if (reset || Object.keys(editedRef.current).length === 0) setRoutes(existingRoutes);
      initializedRef.current = true;
      console.info('控制组已有映射加载完成', { 模块: moduleName, 控制组: nextGroupName, 路由数量: existingRoutes.length });
    } catch (loadError) {
      if (request !== requestRef.current) return;
      initializedRef.current = false;
      setError(`加载已有映射失败：${formatErrorText(loadError)}`);
      console.error('控制组映射加载失败', { 模块: moduleName, 控制组: nextGroupName, 错误: loadError });
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [moduleName]);

  const open = useCallback(async (nextGroupName: string, connId?: number) => {
    console.info('打开控制组映射编辑', { 模块: moduleName, 控制组: nextGroupName, 连接编号: connId });
    await load(nextGroupName, true);
  }, [load, moduleName]);
  const refresh = useCallback(async () => { await load(groupName, false); }, [groupName, load]);
  const getEndpoints = (field: ControlMappingField): DcEndpoint[] =>
    edited[controlMappingFieldKey(field)] ?? getControlMappingEndpoints(routes, moduleName, groupName, field);
  const setEndpoints = (field: ControlMappingField, endpoints: DcEndpoint[]) => {
    const key = controlMappingFieldKey(field);
    const next = { ...editedRef.current, [key]: endpoints };
    editedRef.current = next;
    setEdited(next);
    console.info('控制组映射草稿已修改', { 模块: moduleName, 控制组: groupName, 点位: field.tag, 方向: field.direction, 端点数量: endpoints.length });
  };
  const plan = (fields: ControlMappingField[], bindings: ControlDataBusBinding[] = [], actualGroupName = groupName) => {
    if (loading || error || !initializedRef.current) throw new Error('请先完成已有映射加载，再保存控制组');
    return buildControlMappingPlan({ moduleName, groupName: actualGroupName, fields, baselineRoutes: routes, edited, bindings });
  };
  return { moduleName, groupName, options, routes, loading, error, warning, changed: Object.keys(edited).length > 0, open, refresh, getEndpoints, setEndpoints, plan };
}

export type ControlMappingsDraft = ReturnType<typeof useControlMappings>;
