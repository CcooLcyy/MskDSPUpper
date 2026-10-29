import { useEffect, useReducer, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { Modal } from 'antd';

/** 站内路由不会触发 beforeunload，需单独保护编辑草稿和未完成的同步计划。 */
export default function CalcNavigationGuard({ blocked, locked }: { blocked: boolean; locked: boolean }) {
  const blocker = useBlocker(blocked);
  const showing = useRef(false);
  const [closedRevision, notifyClosed] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    if (blocker.state !== 'blocked' || showing.current) return;
    showing.current = true;
    Modal.confirm({
      title: locked ? '请先处理未完成的保存' : '放弃未保存修改并离开？',
      content: locked ? '计算或关联同步尚未完成，请返回处理或明确重新加载当前配置。' : '离开后将放弃本次尚未保存的计算与关联修改。',
      okText: locked ? '返回处理' : '放弃并离开', cancelText: '继续编辑',
      onOk: () => { if (locked) blocker.reset(); else blocker.proceed(); },
      onCancel: () => blocker.reset(),
      // 关闭动画期间再次导航时，关闭完成后重新检查阻止状态，避免丢掉第二次确认。
      afterClose: () => { showing.current = false; notifyClosed(); },
    });
    console.info('数值计算已阻止站内导航', { 保存未完成: locked });
  }, [blocker, locked, closedRevision]);
  return null;
}
