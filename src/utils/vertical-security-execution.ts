import type { VerticalSecurityStatusResult, VerticalSecurityStepResult } from '../adapters/types.ts';

export type SecurityExecutionPhase = 'deployed' | 'waiting_ppp' | 'applying' | 'completed' | 'failed' | 'unknown';

export type SecurityExecutionOutcome = {
  completed: boolean;
  failed: boolean;
  failedStep: VerticalSecurityStepResult | null;
  phase: SecurityExecutionPhase;
};

export function getSecurityExecutionOutcome(
  status: VerticalSecurityStatusResult | null,
  expectedStepIds: readonly string[],
  queryFailed = false,
): SecurityExecutionOutcome {
  const pending = { completed: false, failed: false, failedStep: null };
  // 查询失败后只保留旧快照供查看，不能把旧成功或旧失败标为当前状态。
  if (queryFailed) return { ...pending, phase: 'unknown' };
  if (!status) return { ...pending, phase: 'deployed' };

  const failedStep = status.steps.find(step => step.state === 'failed') ?? null;
  const failed = Boolean(failedStep || status.active_state === 'failed' || status.sub_state === 'failed'
    || (status.exit_code !== null && status.exit_code !== 0));
  if (failed) return { completed: false, failed: true, failedStep, phase: 'failed' };

  const steps = new Map(status.steps.map(step => [step.step_id, step]));
  const ppp = steps.get('ppp0_wait');
  if (ppp?.state === 'waiting') return { ...pending, phase: 'waiting_ppp' };

  const saved = steps.get('save_config');
  // 后台服务重拨时会留下上轮成功步骤；保存记录必须属于本次 PPP 成功之后。
  const savedAfterPpp = ppp?.state === 'success' && saved?.state === 'success'
    && Number.isFinite(ppp.updated_at) && Number.isFinite(saved.updated_at)
    && saved.updated_at >= ppp.updated_at;
  const completed = expectedStepIds.length > 0 && Boolean(savedAfterPpp)
    && expectedStepIds.every(id => {
      const step = steps.get(id);
      // 重启后 PPP 记录可能尚未更新；新预检查等步骤也不能沿用上轮保存结果。
      return step?.state === 'success' && Number.isFinite(step.updated_at)
        && saved !== undefined && saved.updated_at >= step.updated_at;
    });
  return { ...pending, completed, phase: completed ? 'completed' : 'applying' };
}
