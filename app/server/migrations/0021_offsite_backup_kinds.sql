-- Up Migration
-- Off-device backups (external): the System page reports the copy of verified dumps to an external backup location, the monthly restore-from-NAS test, the weekly
-- configuration bundle and the encrypted recovery-secret escrow. Rows hold no secrets (paths, sizes, checksums, error text).
ALTER TABLE backup_runs DROP CONSTRAINT backup_runs_kind_check;
ALTER TABLE backup_runs ADD CONSTRAINT backup_runs_kind_check
  CHECK (kind IN ('DUMP','USERDATA_EXPORT','CONFIG','RESTORE_TEST','NAS_COPY','NAS_RESTORE_TEST','CONFIG_BUNDLE','ESCROW'));

-- Down Migration
DELETE FROM backup_runs WHERE kind IN ('NAS_COPY','NAS_RESTORE_TEST','CONFIG_BUNDLE','ESCROW');
ALTER TABLE backup_runs DROP CONSTRAINT backup_runs_kind_check;
ALTER TABLE backup_runs ADD CONSTRAINT backup_runs_kind_check CHECK (kind IN ('DUMP','USERDATA_EXPORT','CONFIG','RESTORE_TEST'));
