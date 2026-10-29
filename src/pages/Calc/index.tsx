import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { UNSAFE_DataRouterContext } from 'react-router-dom';
import { App, Alert, Button, Card, Dropdown, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography, message } from 'antd';
import { DeleteOutlined, EditOutlined, MoreOutlined, PauseCircleOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { api } from '../../adapters';
import type { CalcGroupConfig, CalcGroupInfo, CalcItemConfig, DcEndpoint, DcRoute } from '../../adapters';
import { buildCalcRoutePlan, calcInputTags, CalcSaveError, retryCalcRoutes, saveCalcWithRoutes } from '../../utils/calc-routing';
import { formatErrorText } from '../../utils/runtime-restart';
import { defaultItem, defaultOperand, draftFromItem, endpointKey, endpointLabel, formula, isAggregate, isLogic, itemToConfig, operators, validateDraft } from './editor-model';
import type { ItemDraft, OperandDraft } from './editor-model';
import CalcNavigationGuard from './CalcNavigationGuard';
import './index.css';

const { Text } = Typography;
const groupStates: Record<number, { label: string; color: string }> = {
  0: { label: '状态未知', color: 'default' }, 1: { label: '已停止', color: 'default' },
  2: { label: '运行中', color: 'success' }, 3: { label: '待删除', color: 'warning' },
};
type PointOption = { value: string; label: string; point: DcEndpoint };
type Editor = { index: number | null; draft: ItemDraft; initial: string; config: CalcGroupConfig; routes: DcRoute[] };
type GroupDraft = { originalName: string | null; name: string; trigger: number; period: number };

/** 点目录部分加载失败时，已有映射仍独立完整回显。 */
async function loadPointOptions(): Promise<{ options: PointOption[]; warning: string | null }> {
  const connections = await api.dcListConnections();
  const results = await Promise.allSettled(connections.map(async (connection) => {
    const { tags } = await api.dcGetConnTags(connection.conn_id);
    return tags.map((tag) => {
      const point = { module_name: connection.module_name, conn_name: connection.conn_name, tag };
      return { value: endpointKey(point), label: endpointLabel(point), point };
    });
  }));
  const failed = results.filter((result) => result.status === 'rejected').length;
  return { options: results.flatMap((result) => result.status === 'fulfilled' ? result.value : []).sort((a, b) => a.label.localeCompare(b.label, 'zh-CN')),
    warning: failed ? `${failed} 个连接的点位目录加载失败，已有绑定仍保留，可刷新重试。` : null };
}

const CalcPage: React.FC = () => {
  const { modal } = App.useApp();
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  const [messageApi, contextHolder] = message.useMessage();
  const [groups, setGroups] = useState<CalcGroupInfo[]>([]);
  const [groupName, setGroupName] = useState<string | null>(null);
  const [routes, setRoutes] = useState<DcRoute[]>([]);
  const [points, setPoints] = useState<PointOption[]>([]);
  const [catalogWarning, setCatalogWarning] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pending, setPending] = useState<CalcSaveError | null>(null);
  const [groupDraft, setGroupDraft] = useState<GroupDraft | null>(null);
  const groupInitial = useRef('');
  const requestRef = useRef(0);
  const group = groups.find((item) => item.config?.group_name === groupName) ?? null;
  const config = group?.config ?? null;
  const dirty = Boolean(editor && JSON.stringify(editor.draft) !== editor.initial);
  const groupDirty = Boolean(groupDraft && JSON.stringify(groupDraft) !== groupInitial.current);
  const locked = busy || Boolean(pending);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const nextGroups = await api.calcListGroups();
      if (request !== requestRef.current) return;
      setGroups(nextGroups);
      setGroupName((current) => nextGroups.some((item) => item.config?.group_name === current) ? current : nextGroups[0]?.config?.group_name ?? null);
      // 路由接口失败必须保持错误状态，不能伪装成空映射。
      const [nextRoutes, catalog] = await Promise.all([api.dcListRoutes(0, '', 0, ''), loadPointOptions()]);
      if (request !== requestRef.current) return;
      setRoutes(nextRoutes); setPoints(catalog.options); setCatalogWarning(catalog.warning); setLoadError(null);
    } catch (error) {
      if (request === requestRef.current) setLoadError(`加载计算配置或路由失败：${formatErrorText(error)}`);
      console.error('加载计算清单失败', error);
    } finally { if (request === requestRef.current) setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); return () => { requestRef.current += 1; }; }, [refresh]);
  useEffect(() => {
    if (!dirty && !pending && !groupDirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty, pending, groupDirty]);

  const guard = (action: () => void) => {
    if (busyRef.current) return;
    if (pending) { messageApi.warning('请先完成待重试的路由同步或恢复运行'); return; }
    if (dirty) modal.confirm({ title: '放弃未保存修改？', content: '当前计算与点位关联尚未保存。', okText: '放弃修改', cancelText: '继续编辑', onOk: action });
    else action();
  };
  const begin = () => { if (busyRef.current) return false; busyRef.current = true; setBusy(true); return true; };
  const end = () => { busyRef.current = false; setBusy(false); };
  const openEditor = async (index: number | null) => {
    if (!groupName || !begin()) return;
    try {
      const [latest, baselineRoutes, catalog] = await Promise.all([api.calcGetGroup(groupName), api.dcListRoutes(0, '', 0, ''), loadPointOptions()]);
      if (!latest.config) throw new Error('计算分组配置不存在');
      const chosenName = index === null ? null : config?.items[index]?.item_name;
      const actualIndex = index === null ? null : latest.config.items.findIndex((value) => value.item_name === chosenName);
      const item = actualIndex === null ? null : latest.config.items[actualIndex];
      if (index !== null && !item) throw new Error('计算项已被其他操作修改，请刷新');
      const draft = item ? draftFromItem(groupName, item, baselineRoutes) : defaultItem(`计算项${latest.config.items.length + 1}`);
      setGroups((current) => current.map((value) => value.config?.group_name === groupName ? latest : value));
      setRoutes(baselineRoutes); setPoints(catalog.options); setCatalogWarning(catalog.warning); setLoadError(null);
      setEditor({ index: actualIndex, draft, initial: JSON.stringify(draft), config: latest.config, routes: baselineRoutes });
      console.info('打开计算清单内编辑', { 分组: groupName, 计算项: draft.itemName, 新增: index === null });
    } catch (error) { setLoadError(`加载计算项及关联失败：${formatErrorText(error)}`); }
    finally { end(); }
  };
  const editDraft = (change: (draft: ItemDraft) => ItemDraft) => setEditor((current) => current ? { ...current, draft: change(current.draft) } : current);
  const updateInput = (index: number, patch: Partial<OperandDraft>) => editDraft((draft) => ({ ...draft, inputs: draft.inputs.map((input, i) => i === index ? { ...input, ...patch } : input) }));
  const changeOperator = (kind: number) => editDraft((draft) => {
    const count = kind === 5 ? 1 : isAggregate(kind) ? Math.max(2, draft.inputs.length) : 2;
    const inputs = Array.from({ length: count }, (_, index) => draft.inputs[index] ?? defaultOperand()).map((input): OperandDraft => {
      if (input.sourceKind !== 2 || isLogic(kind) === (input.constantType === 'bool')) return input;
      return { ...input, constantType: isLogic(kind) ? 'bool' : 'decimal', constantValue: isLogic(kind) ? false : '0' };
    });
    return { ...draft, operatorKind: kind, inputs };
  });
  const handleSaveError = (error: unknown) => {
    if (error instanceof CalcSaveError && error.configSaved) {
      setPending(error);
      messageApi.warning(error.phase === 'restart' ? '计算与关联已保存，恢复分组运行失败' : '计算已保存，路由同步失败，请重试');
    } else messageApi.error(`保存失败：${formatErrorText(error)}`);
    console.error('保存计算与关联失败', error);
  };
  const saveItem = async () => {
    if (!editor || pending || loadError || !begin()) return;
    try {
      const error = validateDraft(editor.draft);
      if (error) { messageApi.warning(error); return; }
      if (editor.config.items.some((item, index) => index !== editor.index && item.item_name === editor.draft.itemName.trim())) { messageApi.warning('同一分组内计算项名称不能重复'); return; }
      const item = itemToConfig(editor.draft), items = [...editor.config.items];
      if (editor.index === null) items.push(item); else items[editor.index] = item;
      const plan = buildCalcRoutePlan({ groupName: editor.config.group_name,
        previousItem: editor.index === null ? null : editor.config.items[editor.index], item,
        inputSources: editor.draft.inputs.map((input) => input.sourceKind === 1 ? input.sources : []), outputs: editor.draft.outputs, baselineRoutes: editor.routes });
      await saveCalcWithRoutes({ config: { ...editor.config, items }, expectedConfig: editor.config, plan, api });
      setEditor(null); setPending(null); await refresh(); messageApi.success('计算与关联已保存');
      console.info('计算与关联已保存', { 分组: editor.config.group_name, 计算项: item.item_name });
    } catch (error) { handleSaveError(error); await refresh(); } finally { end(); }
  };
  const retry = async () => {
    if (!pending || !begin()) return;
    try { await retryCalcRoutes(pending, api); setPending(null); setEditor(null); await refresh(); messageApi.success('计算与关联同步完成'); }
    catch (error) { handleSaveError(error); } finally { end(); }
  };
  const reloadPending = () => modal.confirm({
    title: '放弃旧重试计划并重新加载？',
    content: '计算配置可能已保存，部分路由可能已同步。重新加载将放弃当前草稿和旧重试计划，读取当前实际配置供你重新检查；不会修改设备配置或运行状态。',
    okText: '放弃并重新加载', cancelText: '继续处理',
    onOk: async () => { setPending(null); setEditor(null); await refresh(); console.info('用户已放弃旧计算关联计划并重新加载'); },
  });
  const deleteItem = async (item: CalcItemConfig) => {
    if (!config || !begin()) return;
    setEditor(null);
    try {
      const latest = await api.calcGetGroup(config.group_name);
      if (!latest.config || JSON.stringify(latest.config) !== JSON.stringify(config)) throw new Error('分组已被其他操作修改，请刷新后重试');
      if (config.items.length <= 1) throw new Error('分组至少保留一个计算项，可删除整个分组');
      const baselineRoutes = await api.dcListRoutes(0, '', 0, '');
      const plan = buildCalcRoutePlan({ groupName: config.group_name, previousItem: item, item: null, inputSources: [], outputs: [], baselineRoutes });
      await saveCalcWithRoutes({ config: { ...config, items: config.items.filter((value) => value.item_name !== item.item_name) }, expectedConfig: config, plan, api });
      setEditor(null); await refresh(); messageApi.success('计算项及相关路由已删除');
    } catch (error) { handleSaveError(error); await refresh(); } finally { end(); }
  };
  const openGroup = (create: boolean) => guard(() => {
    setEditor(null);
    const draft = { originalName: create ? null : config?.group_name ?? null, name: create ? `计算组${groups.length + 1}` : config?.group_name ?? '', trigger: create ? 1 : config?.trigger_mode === 2 ? 2 : 1, period: create ? 1000 : config?.period_ms || 1000 };
    groupInitial.current = JSON.stringify(draft); setGroupDraft(draft);
  });
  const closeGroup = () => {
    if (busyRef.current) return;
    if (groupDirty) modal.confirm({ title: '放弃未保存的分组修改？', okText: '放弃修改', cancelText: '继续编辑', onOk: () => setGroupDraft(null) });
    else setGroupDraft(null);
  };
  const saveGroup = async () => {
    if (!groupDraft || !begin()) return;
    try {
      const name = groupDraft.name.trim();
      if (!name || name.includes('/')) throw new Error('请填写不包含 / 的分组名称');
      if (groups.some((value) => value.config?.group_name === name && name !== groupDraft.originalName)) throw new Error('分组名称已存在');
      if (groupDraft.trigger === 2 && (!Number.isInteger(groupDraft.period) || groupDraft.period <= 0)) throw new Error('计算周期必须为正整数毫秒');
      if (!groupDraft.originalName) {
        const seed = defaultItem('计算项1'); seed.inputs[1] = { ...defaultOperand(), sourceKind: 2 };
        await api.calcUpsertGroup({ group_name: name, trigger_mode: groupDraft.trigger, period_ms: groupDraft.period, items: [itemToConfig(seed)] }, true);
        if ((await api.calcGetGroup(name)).state === 2) await api.calcStopGroup(name);
      } else {
        const latest = await api.calcGetGroup(groupDraft.originalName);
        if (!latest.config || JSON.stringify(latest.config) !== JSON.stringify(config)) throw new Error('分组已变化，请刷新后编辑');
        await saveCalcWithRoutes({ config: { ...latest.config, trigger_mode: groupDraft.trigger, period_ms: groupDraft.period }, expectedConfig: latest.config, plan: { routes: [], removedRoutes: [] }, api });
        if (name !== groupDraft.originalName) {
          const running = (await api.calcGetGroup(groupDraft.originalName)).state === 2;
          if (running) await api.calcStopGroup(groupDraft.originalName);
          try { await api.calcRenameGroup(groupDraft.originalName, name); }
          finally { if (running) { const all = await api.calcListGroups(); const actual = all.some((value) => value.config?.group_name === name) ? name : groupDraft.originalName; await api.calcStartGroup(actual); } }
        }
      }
      setGroupName(name); setGroupDraft(null); await refresh(); messageApi.success('分组配置已保存');
      console.info('保存计算分组设置完成', { 分组: name });
    } catch (error) { if (error instanceof CalcSaveError && error.configSaved) setGroupDraft(null); handleSaveError(error); } finally { end(); }
  };
  const toggleGroup = async () => {
    if (!groupName || !begin()) return;
    try { const latest = await api.calcGetGroup(groupName); if (latest.state === 2) await api.calcStopGroup(groupName); else await api.calcStartGroup(groupName); await refresh(); }
    catch (error) { messageApi.error(`操作分组功能失败：${formatErrorText(error)}`); } finally { end(); }
  };
  const deleteGroup = async () => {
    if (!groupName || !begin()) return;
    try { await api.calcDeleteGroup(groupName); setEditor(null); await refresh(); messageApi.success('计算分组已删除'); }
    catch (error) { messageApi.error(`删除分组失败：${formatErrorText(error)}`); } finally { end(); }
  };
  const pointOptions = (current: DcEndpoint[]) => {
    const options = new Map(points.filter((option) => option.point.module_name !== 'Calc' || option.point.conn_name !== groupName).map((option) => [option.value, option]));
    current.forEach((point) => { const key = endpointKey(point); if (!options.has(key)) options.set(key, { value: key, label: `${endpointLabel(point)}（已有绑定）`, point }); });
    return [...options.values()];
  };
  const pointsFromKeys = (keys: string[], current: DcEndpoint[]): DcEndpoint[] => {
    const options = pointOptions(current);
    return keys.map((key) => options.find((option) => option.value === key)?.point).filter((point): point is DcEndpoint => Boolean(point));
  };
  const renderInput = (input: OperandDraft, index: number) => <div className="calc-operand-editor" key={index}>
    <Text strong>输入 {index + 1}</Text>
    <Select aria-label={`输入${index + 1}来源`} value={input.sourceKind} options={[{ value: 1, label: '点位' }, { value: 2, label: '常量' }]} onChange={(sourceKind) => updateInput(index, { sourceKind })} />
    <div className="calc-operand-value">
      {input.sourceKind === 1 ? <>
        <Select aria-label={`输入${index + 1}关联点位`} showSearch optionFilterProp="label" allowClear mode={input.sources.length > 1 ? 'multiple' : undefined} className="calc-point-select" placeholder="搜索连接名或点位名称" options={pointOptions(input.sources)}
          value={input.sources.length > 1 ? input.sources.map(endpointKey) : input.sources[0] ? endpointKey(input.sources[0]) : undefined}
          onChange={(value: string | string[] | undefined) => updateInput(index, { sources: pointsFromKeys(value === undefined ? [] : Array.isArray(value) ? value : [value], input.sources) })} />
        {input.sources.length > 1 ? <Text type="warning">已有 {input.sources.length} 个来源，数值以最后到达者为准；求和请拆成独立输入。</Text> : null}
      </> : <>
        <Select aria-label={`输入${index + 1}常量类型`} value={input.constantType} options={isLogic(editor!.draft.operatorKind) ? [{ value: 'bool', label: '布尔值' }] : [{ value: 'decimal', label: '精确十进制' }, { value: 'int', label: '整数' }]} onChange={(constantType: OperandDraft['constantType']) => updateInput(index, { constantType, constantValue: constantType === 'bool' ? false : '0' })} />
        {input.constantType === 'bool' ? <Select aria-label={`输入${index + 1}常量值`} value={Boolean(input.constantValue)} options={[{ value: true, label: '真' }, { value: false, label: '假' }]} onChange={(constantValue) => updateInput(index, { constantValue })} /> : <InputNumber<string> aria-label={`输入${index + 1}常量值`} stringMode value={String(input.constantValue)} onChange={(constantValue) => updateInput(index, { constantValue: constantValue ?? '' })} />}
      </>}
    </div>
    {editor && isAggregate(editor.draft.operatorKind) && editor.draft.inputs.length > 2 ? <Button type="text" danger icon={<DeleteOutlined />} aria-label={`移除输入${index + 1}`} onClick={() => editDraft((draft) => ({ ...draft, inputs: draft.inputs.filter((_, i) => i !== index) }))} /> : <span />}
  </div>;
  const renderEditor = () => editor ? <div className="calc-inline-editor">
    <div className="calc-editor-head"><Text strong>{editor.index === null ? '新增计算' : '编辑计算'}</Text><Text type="secondary">{dirty ? '有未保存修改' : '配置与关联草稿'}</Text></div>
    <Form layout="vertical" disabled={locked}>
      <div className="calc-item-basics"><Form.Item label="计算项名称" required><Input aria-label="计算项名称" value={editor.draft.itemName} onChange={(event) => editDraft((draft) => ({ ...draft, itemName: event.target.value }))} /></Form.Item><Form.Item label="运算方式" required><Select aria-label="运算方式" value={editor.draft.operatorKind} options={operators} onChange={changeOperator} /></Form.Item></div>
      <div className="calc-input-section"><div className="calc-section-heading"><Text strong>输入数据</Text><Text type="secondary">{editor.draft.inputs.length} 项输入</Text>{isAggregate(editor.draft.operatorKind) ? <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => editDraft((draft) => ({ ...draft, inputs: [...draft.inputs, defaultOperand()] }))}>添加输入</Button> : null}</div>{editor.draft.inputs.map(renderInput)}</div>
      <div className="calc-formula-preview"><Text type="secondary">计算关系</Text><Text>{editor.draft.itemName || '计算结果'} = {formula(editor.draft)}</Text></div>
      <div className="calc-output-section"><Form.Item label="结果去向" help="可关联多个目标点；留空则仅生成结果点。"><Select aria-label="结果关联目标" mode="multiple" showSearch optionFilterProp="label" allowClear placeholder="搜索并选择结果对应的目标点" options={pointOptions(editor.draft.outputs)} value={editor.draft.outputs.map(endpointKey)} onChange={(keys: string[]) => editDraft((draft) => ({ ...draft, outputs: pointsFromKeys(keys, draft.outputs) }))} /></Form.Item></div>
      <details className="calc-advanced"><summary>高级设置与运行诊断</summary>
        {editor.draft.operatorKind === 10 ? <Form.Item label="平均值小数位数" help="不填写表示不主动舍入，合法范围为 0～20。"><InputNumber aria-label="平均值小数位数" min={0} max={20} precision={0} value={editor.draft.decimalPlaces} onChange={(value) => editDraft((draft) => ({ ...draft, decimalPlaces: value ?? undefined }))} /></Form.Item> : null}
        <Text type="secondary">结果点：Calc/{editor.config.group_name}/{editor.draft.itemName}/result</Text>
        {calcInputTags(itemToConfig(editor.draft)).map((tag, index) => <div key={tag}><Text type="secondary">输入{index + 1}：Calc/{editor.config.group_name}/{tag}</Text></div>)}
        {editor.index !== null ? group?.items.find((item) => item.config?.item_name === editor.config.items[editor.index!]?.item_name)?.operand_status.map((input) => <div key={input.index}><Text type={input.ready ? 'secondary' : 'warning'}>输入{input.index + 1}：{input.ready ? '已就绪' : input.reason || '等待输入'}</Text></div>) : null}
        {editor.index !== null && group?.items.find((item) => item.config?.item_name === editor.draft.itemName)?.last_error ? <Text type="danger">{group.items.find((item) => item.config?.item_name === editor.draft.itemName)?.last_error}</Text> : null}
      </details>
    </Form>
    <div className="calc-editor-footer"><Text type="secondary">选择点位后，保存时统一同步路由。</Text><Space wrap><Button disabled={locked} onClick={() => guard(() => setEditor(null))}>取消</Button><Button type="primary" disabled={Boolean(pending) || Boolean(loadError)} loading={busy} onClick={() => void saveItem()}>保存计算与关联</Button></Space></div>
  </div> : null;
  const itemStatus = (item: CalcItemConfig) => {
    const info = group?.items.find((value) => value.config?.item_name === item.item_name);
    if (group?.state !== 2) return <Tag>未运行</Tag>;
    if (info?.operand_status.some((input) => !input.ready)) return <Tag color="warning">等待输入</Tag>;
    if (info?.last_error) return <Tag color="error">计算异常</Tag>;
    return <Tag color="processing">运行中</Tag>;
  };
  const columns: ColumnsType<CalcItemConfig> = [
    { title: '计算项', dataIndex: 'item_name', key: 'name', width: '22%', render: (name: string) => <Text strong ellipsis={{ tooltip: name }}>{name}</Text> },
    { title: '运算摘要', key: 'formula', render: (_, item) => <div className="calc-item-summary"><Text>{operators.find((operator) => operator.value === item.operator_kind)?.label ?? '未知运算'}</Text><Text type="secondary" ellipsis={{ tooltip: formula(draftFromItem(groupName ?? '', item, routes)) }}>{formula(draftFromItem(groupName ?? '', item, routes))}</Text></div> },
    { title: '结果去向', key: 'output', width: '20%', responsive: ['lg'], render: (_, item) => { const outputs = draftFromItem(groupName ?? '', item, routes).outputs; return <Text type="secondary" ellipsis={{ tooltip: outputs.map(endpointLabel).join('；') }}>{outputs.length ? outputs.length === 1 ? endpointLabel(outputs[0]) : `${outputs.length} 个关联目标` : '仅生成结果点'}</Text>; } },
    { title: '状态', key: 'state', width: 100, render: (_, item) => itemStatus(item) },
    { title: '操作', key: 'actions', width: 120, render: (_, item, index) => <Space size={4}><Button size="small" disabled={locked || loading} onClick={() => guard(() => { if (editor?.index === index) setEditor(null); else void openEditor(index); })}>{editor?.index === index ? '收起' : '编辑'}</Button><Button size="small" danger aria-label={`删除${item.item_name}`} disabled={locked || loading} icon={<DeleteOutlined />} onClick={() => guard(() => modal.confirm({ title: '删除计算项及相关路由？', content: item.item_name, okText: '删除', cancelText: '取消', okButtonProps: { danger: true }, onOk: () => deleteItem(item) }))} /></Space> },
  ];
  const state = groupStates[group?.state ?? 0] ?? groupStates[0];
  return <div className="calc-page">
    {contextHolder}
    {dataRouter ? <CalcNavigationGuard blocked={dirty || groupDirty || locked} locked={locked} /> : null}
    <div className="calc-page-header"><div><Typography.Title level={4}>数值计算</Typography.Title><Text type="secondary">选择输入点，配置运算，并关联结果去向。</Text></div><Space wrap><Button disabled={locked} loading={loading} icon={<ReloadOutlined />} onClick={() => guard(() => { setEditor(null); void refresh(); })}>刷新</Button><Button disabled={locked} icon={<PlusOutlined />} onClick={() => openGroup(true)}>新建分组</Button></Space></div>
    {loadError ? <Alert type="error" showIcon title={loadError} action={<Button size="small" disabled={locked} onClick={() => void refresh()}>重新加载</Button>} /> : null}
    {catalogWarning ? <Alert type="warning" showIcon title={catalogWarning} /> : null}
    {pending ? <Alert type="warning" showIcon title={pending.phase === 'restart' ? '计算与关联已保存，恢复分组运行失败' : '计算已保存，路由同步失败'} description={formatErrorText(pending)} action={<Space wrap><Button disabled={busy} onClick={reloadPending}>重新加载当前配置</Button><Button loading={busy} onClick={() => void retry()}>{pending.phase === 'restart' ? '重试恢复运行' : '重试路由同步'}</Button></Space>} /> : null}
    <div className="calc-group-toolbar"><Space wrap><Select aria-label="计算分组" placeholder="请选择计算分组" className="calc-group-select" value={groupName} disabled={locked || loading} options={groups.map((value) => ({ value: value.config?.group_name, label: value.config?.group_name }))} onChange={(name: string) => guard(() => { setEditor(null); setGroupName(name); })} />{config ? <><Tag color={state.color}>{state.label}</Tag><Text type="secondary">{config.trigger_mode === 2 ? `每 ${config.period_ms} ms 计算` : '输入变化时计算'} · {config.items.length} 项</Text></> : null}</Space>
      {config ? <Space wrap><Button type="primary" disabled={locked || loading} icon={<PlusOutlined />} onClick={() => guard(() => { void openEditor(null); })}>新增计算项</Button><Button disabled={locked} icon={group?.state === 2 ? <PauseCircleOutlined /> : <PlayCircleOutlined />} onClick={() => guard(() => { setEditor(null); void toggleGroup(); })}>{group?.state === 2 ? '停止分组' : '启动分组'}</Button><Dropdown disabled={locked} trigger={['click']} menu={{ items: [{ key: 'edit', label: '编辑分组', icon: <EditOutlined /> }, { key: 'delete', label: '删除分组', danger: true, icon: <DeleteOutlined /> }], onClick: ({ key }) => key === 'edit' ? openGroup(false) : guard(() => modal.confirm({ title: '删除计算分组？', content: groupName, okText: '删除', cancelText: '取消', okButtonProps: { danger: true }, onOk: deleteGroup })) }}><Button disabled={locked} icon={<MoreOutlined />} aria-label="更多分组操作" /></Dropdown></Space> : null}
    </div>
    <Card className="calc-list-card" size="small">{config ? <>
      {group?.last_error ? <details className="calc-group-diagnostic"><summary>分组诊断</summary><Text type="warning">{group.last_error}</Text></details> : null}
      {editor?.index === null ? <div className="calc-new-editor">{renderEditor()}</div> : null}
      <Table<CalcItemConfig> className="calc-items-table" rowKey="item_name" size="middle" tableLayout="fixed" columns={columns} dataSource={config.items} loading={loading} pagination={false} expandable={{ expandedRowKeys: editor && editor.index !== null ? [pending?.configSaved ? editor.draft.itemName.trim() : editor.config.items[editor.index].item_name] : [], expandedRowRender: renderEditor, showExpandColumn: false }} />
    </> : <div className="calc-empty"><Text type="secondary">暂无计算分组，请先新建。</Text><Button icon={<PlusOutlined />} onClick={() => openGroup(true)}>新建分组</Button></div>}</Card>
    <Modal title={groupDraft?.originalName ? '编辑计算分组' : '新建计算分组'} open={Boolean(groupDraft)} onOk={() => void saveGroup()} confirmLoading={busy} okText="保存分组" cancelText="取消" onCancel={closeGroup} mask={{ closable: false }}>
      {groupDraft ? <Form layout="vertical" disabled={busy}><Form.Item label="分组名称" required><Input aria-label="分组名称" value={groupDraft.name} onChange={(event) => setGroupDraft({ ...groupDraft, name: event.target.value })} /></Form.Item><Form.Item label="触发方式"><Select value={groupDraft.trigger} options={[{ value: 1, label: '变化触发' }, { value: 2, label: '周期定时' }]} onChange={(trigger) => setGroupDraft({ ...groupDraft, trigger })} /></Form.Item>{groupDraft.trigger === 2 ? <Form.Item label="计算周期（毫秒）"><InputNumber min={1} precision={0} value={groupDraft.period} onChange={(period) => setGroupDraft({ ...groupDraft, period: period ?? 0 })} /></Form.Item> : null}</Form> : null}
    </Modal>
  </div>;
};

export default CalcPage;
