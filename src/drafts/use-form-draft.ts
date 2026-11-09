import { useCallback, useMemo, useRef, useState } from 'react';
import type { FormInstance } from 'antd';
import { useConfigDraft } from './config-drafts';

type FormDraft = { baseline: string; values: Record<string, unknown> };
type ActiveForm = { key: string; baseline: string; initial: string; stale: boolean; entry?: FormDraft };

function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const entries = Object.entries(item).sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries);
  }) ?? '';
}

export function useFormDraft(page: string, form: FormInstance) {
  const { read, write, clear } = useConfigDraft<FormDraft>(page);
  const active = useRef<ActiveForm | null>(null);
  const [dirty, setDirty] = useState(false);
  const [stale, setStale] = useState(false);

  const begin = useCallback((key: string, baseline: unknown, initial: Record<string, unknown>) => {
    const saved = read(key);
    const current = fingerprint(baseline);
    const isStale = Boolean(saved && saved.baseline !== current);
    active.current = { key, baseline: saved?.baseline ?? current, initial: fingerprint(initial), stale: isStale, entry: saved };
    form.resetFields();
    form.setFieldsValue({ ...initial, ...saved?.values });
    setDirty(Boolean(saved));
    setStale(isStale);
  }, [form, read]);

  const capture = useCallback(() => {
    const editor = active.current;
    if (!editor) return;
    const values = form.getFieldsValue(true) as Record<string, unknown>;
    const changed = editor.stale || fingerprint(values) !== editor.initial;
    editor.entry = changed ? { baseline: editor.baseline, values: structuredClone(values) } : undefined;
    if (editor.entry) write(editor.key, editor.entry);
    else clear(editor.key);
    setDirty(changed);
  }, [clear, form, write]);

  const onValuesChange = useCallback(() => {
    // 某些控件会在本次 change 中一并调整关联字段，等这些同步更新完成后再记录。
    const editor = active.current;
    queueMicrotask(() => { if (active.current === editor) capture(); });
  }, [capture]);

  const discard = useCallback(() => {
    if (active.current) clear(active.current.key);
    active.current = null;
    setDirty(false);
    setStale(false);
  }, [clear]);

  const beginSubmit = useCallback(() => {
    const editor = active.current;
    const submitted = editor && read(editor.key);
    return () => {
      if (!editor || read(editor.key) !== submitted) return;
      clear(editor.key);
      if (active.current === editor) {
        active.current = null;
        setDirty(false);
        setStale(false);
      }
    };
  }, [clear, read]);

  const move = useCallback((key: string, baseline: unknown) => {
    const editor = active.current;
    if (!editor || read(editor.key) !== editor.entry || (key !== editor.key && read(key))) return;
    clear(editor.key);
    active.current = { ...editor, key, baseline: fingerprint(baseline) };
    capture();
  }, [capture, clear, read]);

  return useMemo(() => ({ begin, capture, onValuesChange, discard, dirty, stale, move, beginSubmit }),
    [begin, capture, onValuesChange, discard, dirty, stale, move, beginSubmit]);
}
