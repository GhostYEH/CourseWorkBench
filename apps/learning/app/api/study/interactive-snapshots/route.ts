import { interactiveSnapshotCommandSchema } from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../lib/server/http';
import { requireSession } from '../../../../lib/server/service';
import { commandInteractiveSnapshot } from '../../../../lib/server/interactive-snapshot-service';

export const dynamic = 'force-dynamic';

/**
 * 互动保活快照（OMA-045）：只读读取与受控写入/清除组件临时现场。
 *
 * 只有组件版本（当前文档摘要）一致才恢复；否则明确重置。快照不参与判分、不更新掌握；
 * 本人已提交的互动记录始终保留。
 */
export const POST = route(async (request: Request) =>
  ok(commandInteractiveSnapshot(requireSession(), await parseBody(request, interactiveSnapshotCommandSchema)), {
    headers: { 'cache-control': 'no-store' },
  }),
);
