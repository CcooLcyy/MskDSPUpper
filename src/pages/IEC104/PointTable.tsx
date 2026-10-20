import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Table } from 'antd';
import type { ColumnsType, TableRowSelection } from 'antd/es/table/interface';
import type { Iec104Point } from '../../adapters/types';

export interface Iec104PointTableProps {
  columns: ColumnsType<Iec104Point>;
  points: Iec104Point[];
  selectedTags: string[];
  selectionEnabled: boolean;
  onSelectionChange: (tags: string[]) => void;
  loading: boolean;
  runtime: boolean;
  emptyText: ReactNode;
}

const pointRowKey = (point: Iec104Point) => point.tag;

function Iec104PointTable({
  columns, points, selectedTags, selectionEnabled, onSelectionChange,
  loading, runtime, emptyText,
}: Iec104PointTableProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [bodyHeight, setBodyHeight] = useState(180);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const header = container.querySelector<HTMLElement>('.ant-table-header');
    const measure = () => {
      // 面板隐藏时高度可能暂时为零，此时保留上一次可用的视口高度。
      if (container.clientHeight <= 0) return;
      setBodyHeight(Math.max(80, Math.floor(container.clientHeight - (header?.offsetHeight ?? 40))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    if (header) observer.observe(header);
    return () => observer.disconnect();
  }, []);

  const rowSelection = useMemo<TableRowSelection<Iec104Point> | undefined>(() => selectionEnabled ? {
    selectedRowKeys: selectedTags,
    preserveSelectedRowKeys: true,
    onChange: (keys) => onSelectionChange(keys.map(String)),
  } : undefined, [onSelectionChange, selectedTags, selectionEnabled]);
  const scroll = useMemo(() => ({ x: runtime ? 1100 : 1170, y: bodyHeight }), [bodyHeight, runtime]);
  const locale = useMemo(() => ({ emptyText }), [emptyText]);

  return (
    <div ref={containerRef} className="protocol-table-scroll" style={{ overflow: 'hidden' }}>
      <Table<Iec104Point>
        virtual
        rowKey={pointRowKey}
        columns={columns}
        dataSource={points}
        rowSelection={rowSelection}
        loading={loading}
        pagination={false}
        size="small"
        scroll={scroll}
        locale={locale}
      />
    </div>
  );
}

export default memo(Iec104PointTable);
