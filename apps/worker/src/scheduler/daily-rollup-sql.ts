import { LATENCY_BUCKETS_MS } from '../analytics/latency';

// Only compile-time bucket boundaries form SQL here. All run-time values are
// bound parameters. Aggregate in D1 instead of materializing 43,200 check objects
// in the Worker every midnight.
const histogramColumns = [...LATENCY_BUCKETS_MS, null].map((upper, index) => {
  const lower = index ? LATENCY_BUCKETS_MS[index - 1]! : -1;
  return `sum(CASE WHEN max(0,CAST(latency_ms AS INTEGER)) > ${lower}${upper === null ? '' : ` AND max(0,CAST(latency_ms AS INTEGER)) <= ${upper}`} THEN 1 ELSE 0 END)`;
});

export async function writeDailyRollupsSql(
  db: D1Database,
  dayStart: number,
  dayEnd: number,
  now: number,
): Promise<number> {
  const result = await db
    .prepare(
      `
    WITH input AS MATERIALIZED (
      SELECT id AS monitor_id, interval_sec, max(created_at,?1) AS start_at
      FROM monitors WHERE created_at < ?2
    ),
    checks AS MATERIALIZED (
      SELECT c.id,c.monitor_id,c.checked_at,c.status,c.latency_ms,m.start_at,m.interval_sec
      FROM check_results c JOIN input m ON m.monitor_id=c.monitor_id
      WHERE c.bucket_start_at >= max(0,?1-(SELECT coalesce(max(interval_sec),0)*2 FROM input))-3599
        AND c.checked_at >= max(0,m.start_at-m.interval_sec*2) AND c.checked_at < ?2
    ),
    ordered AS (
      SELECT *,lead(checked_at,1,?2) OVER (
        PARTITION BY monitor_id ORDER BY checked_at,CASE WHEN id>0 THEN 0 ELSE 1 END,id
      ) AS next_at FROM checks
    ),
    known_segments AS MATERIALIZED (
      SELECT monitor_id,max(start_at,checked_at) AS lo,min(next_at,checked_at+interval_sec*2,?2) AS hi
      FROM ordered WHERE status IN ('up','down','maintenance')
    ),
    known AS (
      SELECT monitor_id,sum(max(0,hi-lo)) AS seconds FROM known_segments GROUP BY monitor_id
    ),
    clipped_outages AS (
      SELECT o.monitor_id,max(o.started_at,m.start_at) AS lo,min(coalesce(o.ended_at,?2),?2) AS hi
      FROM outages o JOIN input m ON m.monitor_id=o.monitor_id
      WHERE o.started_at<?2 AND (o.ended_at IS NULL OR o.ended_at>m.start_at)
    ),
    ordered_outages AS (
      SELECT *,max(hi) OVER (PARTITION BY monitor_id ORDER BY lo,hi
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous_hi
      FROM clipped_outages WHERE hi>lo
    ),
    outage_groups AS (
      SELECT *,sum(CASE WHEN previous_hi IS NULL OR lo>previous_hi THEN 1 ELSE 0 END)
        OVER (PARTITION BY monitor_id ORDER BY lo,hi) AS g FROM ordered_outages
    ),
    downtime_segments AS MATERIALIZED (
      SELECT monitor_id,min(lo) AS lo,max(hi) AS hi FROM outage_groups GROUP BY monitor_id,g
    ),
    downtime AS (
      SELECT monitor_id,sum(hi-lo) AS seconds FROM downtime_segments GROUP BY monitor_id
    ),
    known_down AS (
      SELECT k.monitor_id,sum(min(k.hi,d.hi)-max(k.lo,d.lo)) AS seconds
      FROM known_segments k JOIN downtime_segments d ON k.monitor_id=d.monitor_id
      WHERE k.hi>k.lo AND k.hi>d.lo AND d.hi>k.lo GROUP BY k.monitor_id
    ),
    totals AS (
      SELECT m.monitor_id,?2-m.start_at AS total_sec,coalesce(d.seconds,0) AS downtime_sec,
        max(0,?2-m.start_at-coalesce(k.seconds,0)-coalesce(d.seconds,0)+coalesce(o.seconds,0)) AS unknown_sec
      FROM input m LEFT JOIN known k USING(monitor_id) LEFT JOIN downtime d USING(monitor_id)
      LEFT JOIN known_down o USING(monitor_id)
    ),
    stats AS (
      SELECT monitor_id,count(*) AS n,sum(status='up') AS up,sum(status='down') AS down,
        sum(status NOT IN ('up','down','maintenance')) AS unknown,sum(status='maintenance') AS maintenance
      FROM checks WHERE checked_at>=start_at GROUP BY monitor_id
    ),
    latencies AS MATERIALIZED (
      SELECT monitor_id,latency_ms FROM checks WHERE checked_at>=start_at AND status='up'
        AND typeof(latency_ms) IN ('integer','real') AND abs(latency_ms)<=1.7976931348623157e308
    ),
    ranked_latencies AS (
      SELECT *,row_number() OVER (PARTITION BY monitor_id ORDER BY latency_ms) AS rank,
        count(*) OVER (PARTITION BY monitor_id) AS n FROM latencies
    ),
    percentiles AS (
      SELECT monitor_id,
        max(CASE WHEN rank=(n+1)/2 THEN latency_ms END) AS p50,
        max(CASE WHEN rank=(95*n+99)/100 THEN latency_ms END) AS p95
      FROM ranked_latencies GROUP BY monitor_id
    ),
    latency_stats AS (
      SELECT monitor_id,CAST(round(avg(CASE WHEN latency_ms>=0 THEN latency_ms END)) AS INTEGER) AS avg,
        json_array(${histogramColumns.join(',')}) AS histogram
      FROM latencies GROUP BY monitor_id
    )
    INSERT INTO monitor_daily_rollups (
      monitor_id,day_start_at,total_sec,downtime_sec,unknown_sec,uptime_sec,
      checks_total,checks_up,checks_down,checks_unknown,checks_maintenance,
      avg_latency_ms,p50_latency_ms,p95_latency_ms,latency_histogram_json,created_at,updated_at
    )
    SELECT t.monitor_id,?1,t.total_sec,t.downtime_sec,t.unknown_sec,
      max(0,t.total_sec-min(t.total_sec,t.downtime_sec+t.unknown_sec)),
      coalesce(s.n,0),coalesce(s.up,0),coalesce(s.down,0),coalesce(s.unknown,0),coalesce(s.maintenance,0),
      l.avg,p.p50,p.p95,coalesce(l.histogram,?4),?3,?3
    FROM totals t LEFT JOIN stats s USING(monitor_id) LEFT JOIN percentiles p USING(monitor_id)
    LEFT JOIN latency_stats l USING(monitor_id) WHERE 1
    ON CONFLICT(monitor_id,day_start_at) DO UPDATE SET
      total_sec=excluded.total_sec,downtime_sec=excluded.downtime_sec,unknown_sec=excluded.unknown_sec,
      uptime_sec=excluded.uptime_sec,checks_total=excluded.checks_total,checks_up=excluded.checks_up,
      checks_down=excluded.checks_down,checks_unknown=excluded.checks_unknown,
      checks_maintenance=excluded.checks_maintenance,avg_latency_ms=excluded.avg_latency_ms,
      p50_latency_ms=excluded.p50_latency_ms,p95_latency_ms=excluded.p95_latency_ms,
      latency_histogram_json=excluded.latency_histogram_json,updated_at=excluded.updated_at
  `,
    )
    .bind(dayStart, dayEnd, now, JSON.stringify(Array(LATENCY_BUCKETS_MS.length + 1).fill(0)))
    .run();
  return result.meta.changes ?? 0;
}
