import { NextResponse } from 'next/server';
import { SCHEMA_VERSION } from '@sew/study-storage';
import { getSession } from '../../../lib/server/service';
import { bootstrapFromEnvironment } from '../../../lib/server/service';

export const dynamic = 'force-dynamic';

/** 健康端点只返回无敏感的就绪状态。 */
export const GET = (): NextResponse => {
  const session = getSession() ?? bootstrapFromEnvironment();
  return NextResponse.json({
    ok: true,
    data: {
      ready: true,
      schemaVersion: SCHEMA_VERSION,
      instanceId: process.env.SEW_SERVICE_INSTANCE_ID ?? 'standalone',
      dev: process.env.SEW_DEV === '1',
      project: session
        ? {
            projectId: session.projectId,
            displayName: session.displayName,
            generation: session.generation,
          }
        : null,
    },
  });
};
