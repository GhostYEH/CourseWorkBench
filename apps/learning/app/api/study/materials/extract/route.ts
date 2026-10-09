import { StudyError } from '@sew/study-contracts';
import { readBoundedJson } from '../../../../../lib/server/bounded-json';
import { ok, route } from '../../../../../lib/server/http';
import { previewMaterialExtraction } from '../../../../../lib/server/material-extraction';

export const dynamic = 'force-dynamic';

/** Parse bytes from an explicitly authorized native picker path and mint a one-use preview token. */
export const POST = route(async (request: Request) => {
  const input = await readBoundedJson(
    request,
    12 * 1024,
    () => new StudyError('INVALID_ARGUMENT', { reason: 'material_extraction_request_invalid' }),
  );
  const preview = await previewMaterialExtraction(input);
  return ok(preview, { headers: { 'cache-control': 'no-store' } });
});
