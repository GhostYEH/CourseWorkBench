/** A retry sends the original serialized intent. A new attempt requires a known terminal result. */
export interface LessonCommandAttempt {
  body: string;
  state: 'pending' | 'unknown' | 'failed';
}

export const beginLessonCommandAttempt = (
  payload: Record<string, unknown>,
  requestId: string,
): LessonCommandAttempt => ({ body: JSON.stringify({ ...payload, requestId }), state: 'pending' });

export const lessonCommandFailureState = (caught: unknown): 'failed' | 'unknown' => {
  if (caught && typeof caught === 'object' && 'details' in caught) {
    const details = caught.details;
    if (
      details &&
      typeof details === 'object' &&
      'receiptState' in details &&
      (details.receiptState === 'failed' || details.receiptState === 'cancelled')
    )
      return 'failed';
  }
  return 'unknown';
};

export const planConfirmationKey = (revision: number, digest: string | null): string =>
  JSON.stringify([revision, digest]);
