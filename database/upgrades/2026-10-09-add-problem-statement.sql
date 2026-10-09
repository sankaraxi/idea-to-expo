-- =============================================================================
-- Upgrade: add ideas.problem_statement
--
-- Only needed if you imported database/idea_to_expo.sql BEFORE the "Problem
-- Statement" field existed. New imports already include the column.
-- Safe to run more than once (it checks first).
--
--     mysql -u root -p idea_to_expo < database/upgrades/2026-10-09-add-problem-statement.sql
-- =============================================================================

SET @has_column := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ideas' AND COLUMN_NAME = 'problem_statement'
);
SET @ddl := IF(@has_column = 0,
  'ALTER TABLE `ideas` ADD COLUMN `problem_statement` MEDIUMTEXT NULL AFTER `student_id`',
  'SELECT ''ideas.problem_statement already exists'' AS note');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
