import type { ModbusLinkConfig, ModbusPoint } from '../../adapters/types.ts';
import {
  buildReadPlanBlocks, getCoveredReadPlanTags, isExplicitReadFunction,
} from '../../pages/ModbusRTU/modbus-form-rules.ts';
import { formatErrorText } from '../../utils/runtime-restart.ts';

/** 调用方应在同一个停止/恢复周期内调用，并传入停止后重新读取的连接配置。 */
export async function saveTemplateReadPlanAndPoints(options: {
  config: ModbusLinkConfig;
  additions: ModbusPoint[];
  points: ModbusPoint[];
  saveConfig: (config: ModbusLinkConfig) => Promise<void>;
  savePoints: (points: ModbusPoint[]) => Promise<void>;
}): Promise<boolean> {
  const original = options.config;
  const plan = original.read_plan;
  const covered = new Set(getCoveredReadPlanTags(options.additions, plan?.blocks ?? []));
  const uncovered = plan?.mode === 2
    ? options.additions.filter((point) => isExplicitReadFunction(point.function) && !covered.has(point.tag))
    : [];
  const addedBlocks = buildReadPlanBlocks(uncovered);
  if (!addedBlocks.length) {
    await options.savePoints(options.points);
    return false;
  }

  // 保留原手工区间。双寄存器点仅被部分覆盖时追加完整区间，确保同一响应内解码。
  const next: ModbusLinkConfig = {
    ...original,
    read_plan: { mode: 2, blocks: [...(plan?.blocks ?? []).map((block) => ({ ...block })), ...addedBlocks] },
  };
  await options.saveConfig(next);
  try {
    await options.savePoints(options.points);
  } catch (pointError) {
    try {
      await options.saveConfig(original);
    } catch (rollbackError) {
      console.error('Modbus 模板点表保存失败，恢复原读取策略也失败', {
        connection: original.conn_name, pointError, rollbackError,
      });
      throw new Error(`点表保存失败：${formatErrorText(pointError)}；恢复原读取策略失败：${formatErrorText(rollbackError)}。请重新加载连接配置核对。`, { cause: pointError });
    }
    console.warn('Modbus 模板点表保存失败，已恢复原读取策略', {
      connection: original.conn_name, error: pointError,
    });
    throw pointError;
  }
  console.info('Modbus 模板新增点位的批量读取区间已补齐', {
    connection: original.conn_name, points: uncovered.length, blocks: addedBlocks.length,
  });
  return true;
}
