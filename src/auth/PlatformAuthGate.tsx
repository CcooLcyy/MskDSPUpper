import { useLayoutEffect, type ReactNode } from 'react';
import { usePlatformAuth } from './platform-auth-context.ts';
import { PlatformLogin } from './PlatformLogin.tsx';
import './platform-auth.css';

export function PlatformAuthGate({ children }: { children: ReactNode }) {
  const { snapshot } = usePlatformAuth();
  const unlocked = snapshot.phase === 'authenticated';
  useLayoutEffect(() => {
    if (!unlocked) document.body.setAttribute('data-platform-auth-locked', 'true');
    else document.body.removeAttribute('data-platform-auth-locked');
    return () => document.body.removeAttribute('data-platform-auth-locked');
  }, [unlocked]);
  return (
    <>
      {snapshot.workspaceReady ? (
        <div className="platform-auth-workspace" hidden={!unlocked} inert={!unlocked} aria-hidden={!unlocked}>
          {children}
        </div>
      ) : null}
      {!unlocked ? <PlatformLogin /> : null}
    </>
  );
}
