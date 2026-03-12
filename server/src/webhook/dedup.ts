/**
 * In-memory deduplication set for webhook delivery IDs.
 * Prevents duplicate reviews when Svix retries a delivery.
 * NOTE: single-instance only — use Redis if you scale horizontally.
 * Entries expire after TTL_MS to prevent unbounded memory growth.
 */
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class DeduplicationSet {
  private seen = new Set<string>();

  isDuplicate(deliveryId: string): boolean {
    return this.seen.has(deliveryId);
  }

  markSeen(deliveryId: string): void {
    this.seen.add(deliveryId);
    // .unref() prevents the timer from keeping the process alive during graceful shutdown
    const timer = setTimeout(() => this.seen.delete(deliveryId), TTL_MS);
    timer.unref();
  }
}
