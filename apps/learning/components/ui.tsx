import type { CSSProperties, ReactNode, AriaRole } from 'react';
import { MASTERY_STATUS_LABEL, SOURCE_STATUS_LABEL, type MasteryStatus, type SourceStatus } from '@sew/study-contracts';

/** 状态同时使用文字与图标，不用装饰动画替代实际进度。 */

export const SourcePill = ({ status }: { status: SourceStatus }): ReactNode => (
  <span className="pill" data-tone={status === 'verified' ? 'verified' : status === 'pending' ? 'pending' : 'error'}>
    {status === 'verified' ? '✓' : status === 'pending' ? '⏳' : '!'} {SOURCE_STATUS_LABEL[status]}
  </span>
);

export const MasteryPill = ({ status }: { status: MasteryStatus }): ReactNode => (
  <span className="pill" data-tone={status === 'passed' ? 'verified' : status === 'untested' ? 'neutral' : 'pending'}>
    {MASTERY_STATUS_LABEL[status]}
  </span>
);

export const Stat = ({ value, label }: { value: ReactNode; label: string }): ReactNode => (
  <div className="stat">
    <span className="value">{value}</span>
    <span className="label">{label}</span>
  </div>
);

export const Notice = ({
  tone = 'info',
  children,
  style,
  role,
}: {
  tone?: 'info' | 'pending' | 'error' | 'verified';
  children: ReactNode;
  style?: CSSProperties;
  role?: AriaRole;
}): ReactNode => (
  <div className="notice" data-tone={tone === 'info' ? undefined : tone} style={style} role={role}>
    {children}
  </div>
);

export const Empty = ({ children }: { children: ReactNode }): ReactNode => (
  <div className="empty">{children}</div>
);

export const CheckList = ({
  checks,
}: {
  checks: ReadonlyArray<{ code: string; ok: boolean; detail: string }>;
}): ReactNode => (
  <ul className="check-list">
    {checks.map((check, index) => (
      <li key={`${check.code}-${index}`}>
        <span aria-hidden="true">{check.ok ? '✓' : '✕'}</span>
        <span className="mono muted">{check.code}</span>
        <span>{check.detail}</span>
      </li>
    ))}
  </ul>
);
