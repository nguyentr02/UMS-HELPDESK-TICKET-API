/**
 * Per-day reminder dedupe. The job inserts at most one `DailyReminder`
 * notification per agent per day; we guard that with a "tryset" key.
 *
 * `MemoryDedupe` is correct for in-process tests and single-instance dev.
 * Production on Vercel needs a Redis adapter (SETNX with 24h TTL) so the
 * counter survives across serverless instances — slated for Phase 11.
 */
export interface ReminderDedupe {
  /** Returns true if the key was newly set; false if it already existed. */
  trySet(key: string): Promise<boolean>;
}

export class MemoryDedupe implements ReminderDedupe {
  private readonly seen = new Set<string>();

  async trySet(key: string): Promise<boolean> {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  clear(): void {
    this.seen.clear();
  }
}

/** Process-wide singleton used by the route when the caller doesn't inject one. */
export const defaultDedupe = new MemoryDedupe();
