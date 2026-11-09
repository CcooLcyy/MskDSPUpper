import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';

export function createConfigDraftStore() {
  const scopes = new Map<string, Map<string, Map<string, unknown>>>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    has(scope: string, page: string) {
      return Boolean(scopes.get(scope)?.get(page)?.size);
    },
    read<T>(scope: string, page: string, key: string): T | undefined {
      return scopes.get(scope)?.get(page)?.get(key) as T | undefined;
    },
    write(scope: string, page: string, key: string, value: unknown) {
      let pages = scopes.get(scope);
      if (!pages) scopes.set(scope, pages = new Map());
      let drafts = pages.get(page);
      if (!drafts) pages.set(page, drafts = new Map());
      const wasEmpty = drafts.size === 0;
      drafts.set(key, value);
      if (wasEmpty) notify();
    },
    clear(scope: string, page: string, key: string) {
      const pages = scopes.get(scope);
      const drafts = pages?.get(page);
      if (!drafts?.delete(key) || drafts.size) return;
      pages?.delete(page);
      if (!pages?.size) scopes.delete(scope);
      notify();
    },
  };
}

type DraftContext = { store: ReturnType<typeof createConfigDraftStore>; scope: string };
// 独立页面预览和浏览器夹具也可以在当前窗口内恢复草稿。
export const ConfigDraftContext = createContext<DraftContext>({
  store: createConfigDraftStore(),
  scope: 'preview',
});

export function useConfigDraft<T>(page: string) {
  const { store, scope } = useContext(ConfigDraftContext);
  return useMemo(() => ({
    read: (key: string) => store.read<T>(scope, page, key),
    write: (key: string, value: T) => store.write(scope, page, key, value),
    clear: (key: string) => store.clear(scope, page, key),
  }), [store, scope, page]);
}

export function useHasConfigDraft(page: string) {
  const { store, scope } = useContext(ConfigDraftContext);
  return useSyncExternalStore(store.subscribe, () => store.has(scope, page));
}
