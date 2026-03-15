-- Sandbox V2: dev mode + docker compose
-- Renames startup_command → dev_command
-- Replaces detected_infra with compose_file
-- Replaces pre_start_script with schema_command + seed_command
-- Adds login_script, sandbox_template

DO $$
BEGIN
  -- Rename startup_command → dev_command (skip if already renamed)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'repo_configs' AND column_name = 'startup_command'
  ) THEN
    ALTER TABLE repo_configs RENAME COLUMN startup_command TO dev_command;
  END IF;

  -- Drop old columns (skip if already dropped)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'repo_configs' AND column_name = 'detected_infra'
  ) THEN
    ALTER TABLE repo_configs DROP COLUMN detected_infra;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'repo_configs' AND column_name = 'pre_start_script'
  ) THEN
    ALTER TABLE repo_configs DROP COLUMN pre_start_script;
  END IF;
END $$;

ALTER TABLE repo_configs ADD COLUMN IF NOT EXISTS compose_file text;
ALTER TABLE repo_configs ADD COLUMN IF NOT EXISTS schema_command text;
ALTER TABLE repo_configs ADD COLUMN IF NOT EXISTS seed_command text;
ALTER TABLE repo_configs ADD COLUMN IF NOT EXISTS login_script text;
ALTER TABLE repo_configs ADD COLUMN IF NOT EXISTS sandbox_template text;
