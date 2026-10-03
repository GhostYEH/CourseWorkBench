import type { Metadata } from 'next';
import type { CSSProperties, ReactNode } from 'react';
import './theme-tokens.css';
import './globals.css';
import { SessionBootstrap } from '../components/session-bootstrap';
import { DEFAULT_PREFERENCES, getAppearanceStyle } from '../lib/preferences';
import { bootstrapFromEnvironment, getSession } from '../lib/server/service';
import { readPreferences } from '../lib/server/state';

export const metadata: Metadata = {
  title: '学科备考工作台',
  description: '具有来源约束与多智能体互动课堂的本地学习系统',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  let preferences = DEFAULT_PREFERENCES;
  try {
    const session = getSession() ?? bootstrapFromEnvironment();
    if (session) preferences = readPreferences(session);
  } catch {
    // 没有打开的项目时使用默认外观；具体提示由页面负责。
  }

  const initialTheme = preferences.theme === 'system' ? 'light' : preferences.theme;
  const devToken = process.env.SEW_DEV === '1' ? (process.env.SEW_SESSION_TOKEN ?? null) : null;

  const style = getAppearanceStyle(preferences) as CSSProperties;

  return (
    <html
      lang="zh-CN"
      data-theme={initialTheme}
      data-theme-choice={preferences.theme}
      data-accent={preferences.accentPreset}
      data-density={preferences.density}
      style={style}
    >
      <body>
        <SessionBootstrap devToken={devToken} />
        {children}
      </body>
    </html>
  );
}
