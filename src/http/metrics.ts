import type { Db } from "../db/index.ts";

const BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;
type Sample = { count: number; sum: number; buckets: number[] };

function label(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/** Process-local counters. They reset on restart; SQLite-backed event gauges do not. */
export class HttpMetrics {
  private readonly byMethodStatus = new Map<string, Sample>();

  observe(method: string, status: number, milliseconds: number): void {
    const key = `${method.toUpperCase()} ${status}`;
    const sample = this.byMethodStatus.get(key) ?? {
      count: 0, sum: 0, buckets: BOUNDS.map(() => 0),
    };
    const ms = Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0);
    sample.count++;
    sample.sum += ms;
    for (let i = 0; i < BOUNDS.length; i++) {
      if (ms <= BOUNDS[i]!) sample.buckets[i]!++;
    }
    this.byMethodStatus.set(key, sample);
  }

  render(db: Db, now: number): string {
    const out: string[] = [
      "# HELP http_requests_total HTTP requests answered by this process.",
      "# TYPE http_requests_total counter",
    ];
    const entries = [...this.byMethodStatus.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [key, sample] of entries) {
      const [method, status] = key.split(" ");
      out.push(`http_requests_total{method="${label(method!)}",status="${status}"} ${sample.count}`);
    }
    out.push("# HELP http_request_duration_ms HTTP request duration in milliseconds.",
      "# TYPE http_request_duration_ms histogram");
    for (const [key, sample] of entries) {
      const [method, status] = key.split(" ");
      const labels = `method="${label(method!)}",status="${status}"`;
      for (let i = 0; i < BOUNDS.length; i++) {
        out.push(`http_request_duration_ms_bucket{${labels},le="${BOUNDS[i]}"} ${sample.buckets[i]}`);
      }
      out.push(`http_request_duration_ms_bucket{${labels},le="+Inf"} ${sample.count}`,
        `http_request_duration_ms_sum{${labels}} ${sample.sum}`,
        `http_request_duration_ms_count{${labels}} ${sample.count}`);
    }
    const sessions = db.get<{ total: number }>(`select count(*) as total from session
      where revoked_at is null and expires_at > :now`, { now })?.total ?? 0;
    out.push("# HELP manak_active_sessions Unexpired, unrevoked sessions.",
      "# TYPE manak_active_sessions gauge", `manak_active_sessions ${sessions}`);
    const events = db.all<{ slug: string; reviews: number; assigned: number }>(`
      select e.slug,
        (select count(*) from ballot b where b.event_id = e.id and b.submitted_at is not null) as reviews,
        (select count(*) from assignment a where a.event_id = e.id) as assigned
      from event e order by e.slug`);
    out.push("# HELP manak_completed_reviews_total Submitted review records by event.",
      "# TYPE manak_completed_reviews_total gauge",
      "# HELP manak_total_ballots_assigned Active review assignments by event.",
      "# TYPE manak_total_ballots_assigned gauge");
    for (const event of events) {
      const tag = `{event="${label(event.slug)}"}`;
      out.push(`manak_completed_reviews_total${tag} ${event.reviews}`,
        `manak_total_ballots_assigned${tag} ${event.assigned}`);
    }
    out.push("# HELP nodejs_heap_used_bytes V8 heap in use.",
      "# TYPE nodejs_heap_used_bytes gauge",
      `nodejs_heap_used_bytes ${process.memoryUsage().heapUsed}`);
    return out.join("\n") + "\n";
  }
}
