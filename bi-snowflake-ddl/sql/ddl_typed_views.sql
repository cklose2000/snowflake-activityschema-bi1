CREATE OR REPLACE VIEW analytics.activity_cdesk.vw_llm_events AS
SELECT
  activity, customer, ts, link,
  _feature_json:model::STRING          AS model,
  TRY_TO_NUMBER(_feature_json:prompt_tokens)     AS prompt_tokens,
  TRY_TO_NUMBER(_feature_json:completion_tokens) AS completion_tokens,
  TRY_TO_NUMBER(_feature_json:latency_ms)        AS latency_ms,
  TRY_TO_NUMBER(_feature_json:cost_usd)          AS cost_usd
FROM analytics.activity.events
WHERE activity IN ('cdesk.user_asked','cdesk.claude_responded');

CREATE OR REPLACE VIEW analytics.activity_cdesk.vw_sql_events AS
SELECT
  e.activity, e.customer, e.ts, e.link,
  e._query_tag                                               AS query_tag,
  e._feature_json:warehouse::STRING                          AS warehouse,
  TRY_TO_NUMBER(e._feature_json:rows_returned)               AS rows_returned,
  TRY_TO_NUMBER(qh:bytes_scanned)                            AS bytes_scanned,
  TRY_TO_NUMBER(qh:execution_time)                           AS duration_ms,
  (qh:error_message IS NULL)                                 AS success
FROM analytics.activity.events e
LEFT JOIN LATERAL FLATTEN(INPUT => (
  SELECT OBJECT_CONSTRUCT(
    'bytes_scanned', BYTES_SCANNED,
    'execution_time', TOTAL_ELAPSED_TIME,
    'error_message', ERROR_MESSAGE
  )
  FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY(
    END_TIME_RANGE_START=>DATEADD('day',-1,CURRENT_TIMESTAMP()),
    RESULT_LIMIT=>10000
  ))
  WHERE QUERY_TAG = e._query_tag
)) q(qh)
WHERE e.activity = 'cdesk.sql_executed';