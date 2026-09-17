/**
 * 能力查询 Hook。
 *
 * 单独成文件是为了让 `CapabilityGate.tsx` 只导出组件，
 * 避免 react-refresh 的 "only-export-components" 规则告警。
 */

import { useAppMode } from './app-mode-context.ts';
import type { Capability } from './capabilities.ts';

export function useCapability(capability: Capability): boolean {
  return useAppMode().can(capability);
}
