-- Streams on base events + insight atoms
CREATE OR REPLACE STREAM analytics.activity_cdesk.s_events
  ON TABLE analytics.activity.events;

CREATE OR REPLACE STREAM analytics.activity_cdesk.s_insight_atoms
  ON TABLE analytics.activity_cdesk.insight_atoms;

-- Task: refresh context when new rows arrive (merge recent metrics + recent intents)
CREATE OR REPLACE TASK analytics.activity_cdesk.t_refresh_context
  WAREHOUSE = COMPUTE_XS
  SCHEDULE = 'USING CRON * * * * * UTC'  -- guard; will skip if no data
AS
  BEGIN
    IF (SYSTEM$STREAM_HAS_DATA('ANALYTICS.ACTIVITY_CDESK.S_EVENTS')
        OR SYSTEM$STREAM_HAS_DATA('ANALYTICS.ACTIVITY_CDESK.S_INSIGHT_ATOMS')) THEN

      MERGE INTO analytics.activity_cdesk.context_cache t
      USING (
        WITH recent_atoms AS (
          SELECT customer,
                 OBJECT_AGG(subject||':'||metric, value) AS metrics
          FROM analytics.activity_cdesk.insight_atoms
          WHERE ts > DATEADD('hour', -24, CURRENT_TIMESTAMP())
            AND (valid_until IS NULL OR valid_until > CURRENT_TIMESTAMP())
          GROUP BY customer
        ),
        recent_intents AS (
          SELECT customer,
                 ARRAY_AGG(activity) WITHIN GROUP (ORDER BY ts DESC) AS last_activities
          FROM analytics.activity.events
          WHERE ts > DATEADD('hour', -2, CURRENT_TIMESTAMP())
            AND activity LIKE 'cdesk.%'
          GROUP BY customer
        )
        SELECT COALESCE(a.customer, i.customer) AS customer,
               OBJECT_CONSTRUCT('metrics', a.metrics,
                                'recent_activities', i.last_activities,
                                'timestamp', CURRENT_TIMESTAMP()) AS context_blob
        FROM recent_atoms a
        FULL OUTER JOIN recent_intents i ON a.customer = i.customer
      ) s
      ON t.customer = s.customer
      WHEN MATCHED THEN UPDATE SET context_blob = s.context_blob, updated_at = SYSDATE()
      WHEN NOT MATCHED THEN INSERT (customer, context_blob, updated_at)
                              VALUES (s.customer, s.context_blob, SYSDATE());

    END IF;
  END;

-- (Optional) Task to materialize or verify occurrence/repeated_at if not computed on ingest
CREATE OR REPLACE TASK analytics.activity_cdesk.t_derivations
  WAREHOUSE = COMPUTE_XS
  SCHEDULE = 'USING CRON */5 * * * * UTC'
AS
  MERGE INTO analytics.activity.events e
  USING (
    SELECT activity, customer, ts,
           ROW_NUMBER() OVER (PARTITION BY customer, activity ORDER BY ts) AS rn,
           LEAD(ts)    OVER (PARTITION BY customer, activity ORDER BY ts) AS next_ts
    FROM analytics.activity.events
    QUALIFY rn = 1 OR next_ts IS NOT NULL
  ) d
  ON e.activity = d.activity AND e.customer = d.customer AND e.ts = d.ts
  WHEN MATCHED THEN UPDATE SET e.activity_occurrence = d.rn, e.activity_repeated_at = d.next_ts;