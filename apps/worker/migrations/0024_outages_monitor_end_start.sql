-- Current-day reads and updates of the open outage must not scan every closed
-- outage a monitor accumulated. Cover both disjoint end-time ranges without
-- changing retention, sample precision, or canonical outage data.
CREATE INDEX idx_outages_monitor_end_start
  ON outages(monitor_id, ended_at, started_at);
