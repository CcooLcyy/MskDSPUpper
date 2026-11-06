/** 逻辑列表、表达式和数值聚合共享编号输入；旧二元逻辑保留左右槽位。 */
export function calcUsesOperandList(item: { operator_kind: number; operands?: readonly unknown[] }): boolean {
  return [9, 10, 11].includes(Number(item.operator_kind))
    || ([6, 7, 8].includes(Number(item.operator_kind)) && (item.operands?.length ?? 0) > 0);
}
