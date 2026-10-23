import { useEffect } from 'react';
import { App } from 'antd';
import { usePlatformAuth } from '../../auth/platform-auth-context';
import { isPlatformDesktop } from '../../auth/platform-auth-api';
import { platformTemplateCatalog, cachedPlatformSummaries } from './catalog';
import { normalizePlatformId } from './catalog-core';
/** 登录或平台恢复连接后检查目录，无需连接任何下位机。 */
export function PlatformTemplateMonitor() {
  const {
    controller,
    snapshot
  } = usePlatformAuth();
  const {
    notification
  } = App.useApp();
  const platformId = normalizePlatformId(snapshot.settings?.grpc_endpoint ?? '');
  const username = snapshot.status?.username ?? '';
  useEffect(() => {
    if (!isPlatformDesktop() || snapshot.phase !== 'authenticated' || !platformId || !username) return;
    let active = true;
    const current = () => {
      const now = controller.getSnapshot();
      return active && now.phase === 'authenticated' && normalizePlatformId(now.settings?.grpc_endpoint ?? '') === platformId && now.status?.username === username;
    };
    const previous = cachedPlatformSummaries(platformId);
    const catalog = platformTemplateCatalog(platformId, username, current);
    void catalog.list(platformId).then(result => {
      if (!current() || result.cached || !previous) return;
      const old = new Map(previous.map(item => [item.id, item.revision]));
      const count = result.summaries.filter(item => old.get(item.id) !== item.revision).length;
      const deleted = previous.filter(item => !result.summaries.some(next => next.id === item.id)).length;
      if (count || deleted) notification.info({
        title: '平台点表目录有更新',
        description: `${count} 张模板新增或更新，${deleted} 张移出目录。连接下位机后可查看具体差异并确认更正。`,
        duration: 8
      });
    }).catch(error => {
      if (current()) console.warn('登录后检查平台点表目录失败', error);
    });
    return () => {
      active = false;
    };
  }, [controller, notification, platformId, username, snapshot.phase, snapshot.status?.connection_state]);
  return null;
}
