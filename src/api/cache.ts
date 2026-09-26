/** Bounded, revision-aware memoization. Call only after authorization; never cache responses. */
export class RevisionCache {
  private readonly owners = new WeakMap<object, Map<string, { revision: string; values: Map<string, unknown> }>>();
  constructor(privateMaxEvents = 16, privateMaxVariants = 8) {
    if (!Number.isInteger(privateMaxEvents) || privateMaxEvents < 1 ||
        !Number.isInteger(privateMaxVariants) || privateMaxVariants < 1) throw new RangeError("Cache bounds must be positive integers.");
    this.maxEvents = privateMaxEvents;
    this.maxVariants = privateMaxVariants;
  }
  private readonly maxEvents: number;
  private readonly maxVariants: number;

  get<T>(owner: object, event: string, revision: string, variant: string, compute: () => T): T {
    let events = this.owners.get(owner);
    if (!events) { events = new Map(); this.owners.set(owner, events); }
    let entry = events.get(event);
    if (!entry || entry.revision !== revision) {
      entry = { revision, values: new Map() };
    }
    events.delete(event);
    if (events.size >= this.maxEvents) events.delete(events.keys().next().value!);
    events.set(event, entry);
    if (entry.values.has(variant)) return entry.values.get(variant) as T;
    const value = compute(); // Failed work is never retained.
    if (entry.values.size >= this.maxVariants) entry.values.delete(entry.values.keys().next().value!);
    entry.values.set(variant, value);
    return value;
  }
}
