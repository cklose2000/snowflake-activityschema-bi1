-- Tool-specific objects live outside the spec surface.
CREATE SCHEMA IF NOT EXISTS analytics.activity_cdesk;

-- Structured memory (authoritative recall)
CREATE TABLE IF NOT EXISTS analytics.activity_cdesk.insight_atoms (
  id                      STRING           DEFAULT UUID_STRING() PRIMARY KEY,
  ts                      TIMESTAMP_NTZ    DEFAULT SYSDATE(),
  customer                STRING           NOT NULL,
  subject                 STRING           NOT NULL,    -- e.g., 'revenue', 'churn'
  metric                  STRING           NOT NULL,    -- 'total', 'rate', 'delta'
  value                   VARIANT          NOT NULL,    -- scalar or tiny array
  grain                   STRING,                        -- 'daily', 'segment'
  filter_json             VARIANT,
  confidence              FLOAT,
  artifact_id             STRING,
  provenance_query_hash   STRING,
  valid_until             TIMESTAMP_NTZ
)
CLUSTER BY (customer, subject, ts);

-- Artifact metadata + preview (big data lives in S3)
CREATE TABLE IF NOT EXISTS analytics.activity_cdesk.artifacts (
  artifact_id             STRING           PRIMARY KEY,
  created_ts              TIMESTAMP_NTZ    DEFAULT SYSDATE(),
  customer                STRING,
  artifact_type           STRING,          -- table/chart/export
  sample                  VARIANT,         -- ≤10 rows, ≤128KB
  row_count               INT,
  content_schema          VARIANT,         -- columns/types
  s3_url                  STRING,
  bytes                   INT,
  created_by_activity     STRING           -- reference to events.activity row (activity+ts+customer)
);

-- Context cache (read-optimization, not authoritative)
CREATE TABLE IF NOT EXISTS analytics.activity_cdesk.context_cache (
  customer                STRING           PRIMARY KEY,
  context_blob            VARIANT,         -- metrics/filters/definitions/recent intents
  updated_at              TIMESTAMP_NTZ
);