import React from 'react';
import { useAppMode } from '../app-mode-context.ts';
import type { Capability } from '../capabilities.ts';

export interface CapabilityGateProps {
  /** 需要的能力；不具备时渲染 fallback（默认什么都不渲染）。 */
  need: Capability;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

/**
 * 声明式能力门禁。
 *
 * 页面用它包裹"运行态相关区块"，而不是自己判断模式：
 * 在线模式下矩阵全为真，门禁恒渲染，行为与改造前完全一致。
 */
const CapabilityGate: React.FC<CapabilityGateProps> = ({ need, children, fallback = null }) => {
  const { can } = useAppMode();

  return <>{can(need) ? children : fallback}</>;
};

export default CapabilityGate;
