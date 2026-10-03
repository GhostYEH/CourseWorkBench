import type { ReactNode } from 'react';
import { AppearanceSettings } from '../../../components/appearance-settings';
import { bootstrapFromEnvironment, getSession } from '../../../lib/server/service';
import { readPreferences } from '../../../lib/server/state';

export const dynamic = 'force-dynamic';

export default function AppearancePage(): ReactNode {
  const session = (getSession() ?? bootstrapFromEnvironment())!;
  const preferences = readPreferences(session);

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>外观与阅读</h1>
          <p>
            首版风格定制采用有范围的令牌：不允许导入任意 CSS、脚本、远程字体或插件。
            个性化设置只改变显示，不向 Markdown 产物注入颜色、字体或皮肤。
          </p>
        </div>
      </div>

      <AppearanceSettings initial={preferences} />

      <div className="card">
        <h2>设置边界</h2>
        <table>
          <thead>
            <tr>
              <th>设置</th>
              <th>首版能力</th>
              <th>保存范围</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>主题</td>
              <td>纸色、浅色、暗色、跟随系统</td>
              <td>全局</td>
            </tr>
            <tr>
              <td>强调色</td>
              <td>朱砂、深青、靛蓝三个经过验证的预设</td>
              <td>全局；各主题配套前景色</td>
            </tr>
            <tr>
              <td>正文字号 / 行距 / 宽度</td>
              <td>16—24 px / 1.5—2.0 / 640—920 px</td>
              <td>全局</td>
            </tr>
            <tr>
              <td>密度</td>
              <td>标准 / 紧凑（不降低阅读行高、不缩小来源字号）</td>
              <td>全局</td>
            </tr>
            <tr>
              <td>面板</td>
              <td>宽度、折叠、底部高度</td>
              <td>全局或项目视图</td>
            </tr>
          </tbody>
        </table>
        <p className="muted">
          图片皮肤、自定义字体导入和任意色值选择属于后续能力；如加入，阅读区仍保留不透明背景并校验对比度。
        </p>
      </div>
    </div>
  );
}
