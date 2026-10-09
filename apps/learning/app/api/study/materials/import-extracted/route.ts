import { StudyError } from '@sew/study-contracts';
import { toMaterialDto, toSegmentDto } from '../../../../../lib/server/dto';
import { readBoundedJson } from '../../../../../lib/server/bounded-json';
import { ok, route } from '../../../../../lib/server/http';
import { confirmMaterialExtraction } from '../../../../../lib/server/material-extraction';

export const dynamic = 'force-dynamic';

/** Confirm the exact server-side extraction preview bound to the current file bytes and project. */
export const POST = route(async (request: Request) => {
  const input = await readBoundedJson(
    request,
    12 * 1024,
    () =>
      new StudyError('INVALID_ARGUMENT', { reason: 'material_extraction_confirmation_invalid' }),
  );
  const result = confirmMaterialExtraction(input);
  return ok(
    {
      material: toMaterialDto(result.material),
      segments: result.segments.map(toSegmentDto),
      invalidated: result.invalidated,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
});
