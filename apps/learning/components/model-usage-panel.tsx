import type {
  ModelUsageCallDto,
  ModelUsagePurpose,
  ModelUsageReportDto,
} from '@sew/study-contracts';

const PURPOSE_LABEL: Record<ModelUsagePurpose, string> = {
  lesson_draft: '课程草案',
  teaching_prompt: '课堂教师',
  peer_turn: 'AI 同学',
  attempt_grading: '模型评分',
  error_attribution: '错因归因',
  review_suggestion: '复习建议',
  statement_revision: '陈述改写',
  courseware_generation: '完整课件生成',
  collab_teaching_ai: '公共教师 / AI 同学候选',
  pbl_guidance: 'PBL 导师 / 同行候选',
  media_generation: '媒体生成 / 转写候选',
};

const MEASUREMENT_LABEL = { actual: '实际', estimated: '估算', unknown: '未知' } as const;

const STATE_LABEL: Record<ModelUsageCallDto['state'], string> = {
  started: '已派发，结果未确认',
  completed: '已完成',
  failed: '失败或取消',
};

/**
 * 共享预算与用量（BUDGET-01）。
 *
 * 生成、教师、AI 同学、模型评分、错因归因与复习共用同一份 run 额度，
 * 所以这里合并显示：实际 / 估算 / 未知三档分开，未结算的预占单独列出。
 * 费用没有价格依据时显示「未知」，不显示 0 元——那会让人以为这笔调用免费。
 */
export const ModelUsagePanel = ({
  calls,
  usage,
  report = null,
}: {
  calls: ModelUsageCallDto[];
  usage: { calls: number; tokens: number };
  report?: ModelUsageReportDto | null;
}) => (
  <div className="card">
    <h2>模型调用与累计预算</h2>
    <p>
      当前任务累计 {usage.calls} 次调用，计入预算 {usage.tokens} tokens（含未确认调用的保守预留）。
    </p>
    <p className="secondary">
      所有角色与用途共用这一份额度：课程草案、课堂教师、AI 同学、模型评分、错因归因与复习。
      服务商未提供用量时按未知处理并保留预占；价格未配置，费用一律显示未知。
      已派发但未确认的调用不会在恢复后自动重发。
    </p>
    {report ? (
      <>
        <p className="mono">
          剩余：{report.remainingCalls} 次 / {report.remainingTokens} tokens · 执行用时{' '}
          {Math.round(report.activeElapsedMs / 1000)}s / {Math.round(report.maxWallClockMs / 1000)}s
          {report.wallClockExhausted ? '（执行时限已到，等待本人输入的时间不计入）' : ''}
        </p>
        <p className="secondary">
          用量口径：实际 {report.total.actualTokens} · 估算 {report.total.estimatedTokens} · 未知{' '}
          {report.total.unknownTokens} · 未结算预占 {report.total.reservedTokens} tokens。
          费用：实际 {report.total.actualCost === null ? '未知' : report.total.actualCost} · 估算{' '}
          {report.total.estimatedCost === null ? '未知' : report.total.estimatedCost} ·
          {report.total.unknownCostCalls} 次调用费用未知。
        </p>
        {report.byPurpose.length > 0 ? (
          <ul className="check-list">
            {report.byPurpose.map((item) => (
              <li key={item.purpose}>
                <span>
                  {PURPOSE_LABEL[item.purpose]}：{item.summary.calls} 次
                </span>
                <span className="muted mono">
                  实际 {item.summary.actualTokens} · 估算 {item.summary.estimatedTokens} · 未知{' '}
                  {item.summary.unknownTokens} · 预占 {item.summary.reservedTokens}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {report.unsettled.length > 0 ? (
          <p className="secondary">
            尚未结算的调用 {report.unsettled.length} 笔（额度仍被占用，需人工核对）：
            {report.unsettled
              .map((item) => ` ${PURPOSE_LABEL[item.purpose]}/${item.requestId}`)
              .join('、')}
          </p>
        ) : null}
      </>
    ) : null}
    {calls.length === 0 ? (
      <p>还没有课程、教师、同学或评分调用。</p>
    ) : (
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>用途 / 状态</th>
              <th>请求模型 / 实际模型</th>
              <th>用量口径</th>
              <th>耗时</th>
              <th>费用</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((call) => (
              <tr key={call.requestId}>
                <td>
                  {PURPOSE_LABEL[call.purpose]} / {STATE_LABEL[call.state]}
                  <br />
                  <small>{call.createdAt}</small>
                </td>
                <td>
                  {call.requestedModel ?? '未知'} / {call.returnedModel ?? '未知'}
                  <br />
                  <small>{call.provider ?? '未知'}</small>
                </td>
                <td>
                  {MEASUREMENT_LABEL[call.tokenMeasurement]}
                  {call.accountedTokens === null
                    ? `（保守预留 ${call.reservedTokens}）`
                    : `：${call.accountedTokens} tokens`}
                </td>
                <td>{call.elapsedMs === null ? '未知' : `${call.elapsedMs} ms`}</td>
                <td>
                  {call.cost === null
                    ? '未知'
                    : `${call.cost}（${MEASUREMENT_LABEL[call.costMeasurement]}）`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </div>
);
