'use client';

import { useEffect, useState } from 'react';
import type { ServiceStatusPayload } from '@sew/study-contracts';
import { setSessionToken } from '../lib/client';
import { subscribeService } from '../lib/service-subscription';

/**
 * 注入应用会话凭据。
 *
 * - 打包运行时：由 preload 通过受控通道推送（凭据不进 URL、日志与持久存储）。
 * - 浏览器直开（开发）：由服务端在 dev 模式下把本次进程的凭据作为 props 传入，
 *   仅用于本地调试；生产构建下 devToken 恒为 null。
 */
export const SessionBootstrap = ({ devToken }: { devToken: string | null }) => {
  const [serviceStatus, setServiceStatus] = useState<ServiceStatusPayload | null>(null);

  useEffect(() => {
    const bridge = window.sewNative;
    if (bridge) {
      return subscribeService(bridge, setServiceStatus, setSessionToken);
    }
    if (devToken) setSessionToken(devToken);
    return undefined;
  }, [devToken]);

  if (serviceStatus?.state !== 'crashed') return null;
  return (
    <section role="alert" aria-live="assertive" className="service-crash-banner">
      <div>
        <strong>本地学习服务已意外停止</strong>
        <p>{serviceStatus.message}请先退出应用，再重新打开以恢复学习。</p>
      </div>
      <button type="button" className="btn" onClick={() => window.sewNative?.closeWindow()}>
        退出应用
      </button>
      <style jsx>{`
        .service-crash-banner {
          position: fixed;
          z-index: 1000;
          inset: 0 0 auto;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--sew-space-4);
          padding: var(--sew-space-4) var(--sew-space-5);
          color: var(--sew-status-error);
          background: var(--sew-surface-card);
          border-bottom: 1px solid var(--sew-status-error);
        }
        .service-crash-banner p { margin: var(--sew-space-1) 0 0; }
        @media (max-width: 640px) {
          .service-crash-banner { align-items: flex-start; flex-direction: column; }
        }
      `}</style>
    </section>
  );
};
