/** Keep a failed or interrupted command's nonce until its receipt is acknowledged. */
export const createGradingRequestIds = (allocate: () => string = () => crypto.randomUUID()) => {
  const pending = new Map<string, string>();
  return {
    forIntent(intent: readonly unknown[]): string {
      const fingerprint = JSON.stringify(intent);
      const existing = pending.get(fingerprint);
      if (existing) return existing;
      const id = allocate();
      pending.set(fingerprint, id);
      return id;
    },
    acknowledge(requestId: string): void {
      for (const [intent, id] of pending) if (id === requestId) pending.delete(intent);
    },
  };
};
