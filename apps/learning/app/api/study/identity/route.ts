import { z } from 'zod';
import type { NextResponse } from 'next/server';
import { learnerProfileUpdateSchema } from '@sew/study-contracts';
import { ok, parseBody, parseQuery, route } from '../../../../lib/server/http';
import { getLearnerProfile, updateLearnerProfile } from '../../../../lib/server/learner-profile';

export const dynamic = 'force-dynamic';
const noQuerySchema = z.object({}).strict();
const noStoreRoute = (handler: (request: Request) => NextResponse | Promise<NextResponse>) => {
  const handle = route(handler);
  return async (request: Request) => {
    const response = await handle(request);
    response.headers.set('cache-control', 'no-store');
    return response;
  };
};

export const GET = noStoreRoute((request: Request) => {
  parseQuery(request, noQuerySchema);
  return ok(getLearnerProfile());
});

export const PUT = noStoreRoute(async (request: Request) => {
  parseQuery(request, noQuerySchema);
  const input = await parseBody(request, learnerProfileUpdateSchema);
  return ok(updateLearnerProfile(input));
});
