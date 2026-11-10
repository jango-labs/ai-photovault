-- Up Migration
-- The application checks at start-up that its schema is complete (src/db/schema-check.ts). It runs as pv_app, which could not read the list of applied
-- migrations. Read-only; names of migrations are not sensitive.
GRANT SELECT ON schema_migrations TO pv_app;

-- Down Migration
REVOKE SELECT ON schema_migrations FROM pv_app;
