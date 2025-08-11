-- Example Row Access Policy keyed on customer
CREATE OR REPLACE ROW ACCESS POLICY analytics.activity.rap_customer
AS (customer STRING) RETURNS BOOLEAN ->
  CURRENT_ROLE() IN ('DATA_SCIENTIST','ANALYST') OR
  customer = CURRENT_USER();

ALTER TABLE analytics.activity.events
  ADD ROW ACCESS POLICY analytics.activity.rap_customer ON (customer);

-- Example masking policy for sensitive feature_json fields
CREATE OR REPLACE MASKING POLICY analytics.activity.mp_feature_json AS (v VARIANT) RETURNS VARIANT ->
  CASE WHEN CURRENT_ROLE() IN ('DATA_SCIENTIST','SECURITY_ADMIN') THEN v
       ELSE OBJECT_DELETE(v, 'pii')
  END;

ALTER TABLE analytics.activity.events
  MODIFY COLUMN _feature_json SET MASKING POLICY analytics.activity.mp_feature_json;

-- Retention defaults (adjust as needed)
ALTER TABLE analytics.activity.events
  SET DATA_RETENTION_TIME_IN_DAYS = 180;

ALTER TABLE analytics.activity_cdesk.artifacts
  SET DATA_RETENTION_TIME_IN_DAYS = 90;