-- =============================================================================
-- Upgrade: add evaluations.decision (Selected / Waitlisted / Rejected)
--
-- Only needed if you imported database/idea_to_expo.sql BEFORE the "Status"
-- field existed. New imports already include the column.
-- Safe to run more than once (it checks first). Existing evaluations keep
-- decision = NULL ("not set") until an evaluator or admin sets it.
--
--     mysql -u root -p idea_to_expo < database/upgrades/2026-10-09-add-decision.sql
-- =============================================================================

SET @has_column := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'evaluations' AND COLUMN_NAME = 'decision'
);
SET @ddl := IF(@has_column = 0,
  'ALTER TABLE `evaluations` ADD COLUMN `decision` ENUM(''SELECTED'',''WAITLISTED'',''REJECTED'') NULL AFTER `status`, ADD KEY `ix_evaluations_decision` (`decision`)',
  'SELECT ''evaluations.decision already exists'' AS note');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
