import { useEffect, useReducer, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { App } from 'antd';

/** 草稿可随时切页，正在提交或等待重试的同步计划需先处理。 */
export default function CalcNavigationGuard({ blocked }: { blocked: boolean }) {
  const { modal } = App.useApp();
  const blocker = useBlocker(blocked);
  const showing = useRef(false);
  const [closedRevision, notifyClosed] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    if (blocker.state !== 'blocked' || showing.current) return;
    showing.current = true;
    modal.confirm({
      title: '请先处理未完成的保存',
      content: '计算或关联同步尚未完成，请返回处理或明确重新加载当前配置。',
      okText: '返回处理', cancelText: '继续编辑',
      onOk: () => blocker.reset(),
      onCancel: () => blocker.reset(),
      // 关闭动画期间再次导航时，关闭完成后重新检查阻止状态，避免丢掉第二次确认。
      afterClose: () => { showing.current = false; notifyClosed(); },
    });
    console.info('数值计算已阻止站内导航，保存尚未完成');
  }, [blocker, closedRevision, modal]);
  return null;
}
