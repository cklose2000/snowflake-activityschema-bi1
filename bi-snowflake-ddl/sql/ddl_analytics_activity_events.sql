-- analytics.activity.events — STRICT Activity Schema v2 (POC + future org-wide)
CREATE SCHEMA IF NOT EXISTS analytics.activity;

CREATE TABLE IF NOT EXISTS analytics.activity.events (
  -- REQUIRED BY SPEC
  activity                 STRING           NOT NULL,   -- e.g., 'cdesk.user_asked'
  customer                 STRING           NOT NULL,   -- org-wide user/entity id
  ts                       TIMESTAMP_NTZ    NOT NULL,   -- event time
  activity_repeated_at     TIMESTAMP_NTZ,               -- LEAD(ts) over (customer, activity)
  activity_occurrence      NUMBER           NOT NULL,   -- ROW_NUMBER() over (customer, activity)

  -- OPTIONAL BY SPEC
  link                     STRING,                      -- artifact id or URL to renderer
  revenue_impact           NUMBER,                      -- pick ONE unit (e.g., USD)

  -- EXTENSIONS (ignored by spec via underscore prefix)
  _feature_json            VARIANT,                     -- tokens/latency/rows/bytes/etc.
  _source_system           STRING DEFAULT 'claude_desktop',
  _source_version          STRING DEFAULT '2.0',
  _session_id              STRING,
  _query_tag               STRING
)
CLUSTER BY (customer, ts);

-- Enforce uniqueness for idempotent ingest (use UUID in the app)
CREATE TABLE IF NOT EXISTS analytics.activity._ingest_ids (id STRING PRIMARY KEY);

-- Helper view for consumers who want base columns only (no extensions)
CREATE OR REPLACE VIEW analytics.activity.vw_events_base AS
SELECT activity, customer, ts, activity_repeated_at, activity_occurrence, link, revenue_impact
FROM analytics.activity.events;