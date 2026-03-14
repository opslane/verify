-- Sandbox V2: dev mode + docker compose
-- Renames startup_command → dev_command
-- Replaces detected_infra with compose_file
-- Replaces pre_start_script with schema_command + seed_command
-- Adds login_script, sandbox_template

ALTER TABLE repo_configs RENAME COLUMN startup_command TO dev_command;

ALTER TABLE repo_configs DROP COLUMN detected_infra;
ALTER TABLE repo_configs DROP COLUMN pre_start_script;

ALTER TABLE repo_configs ADD COLUMN compose_file text;
ALTER TABLE repo_configs ADD COLUMN schema_command text;
ALTER TABLE repo_configs ADD COLUMN seed_command text;
ALTER TABLE repo_configs ADD COLUMN login_script text;
ALTER TABLE repo_configs ADD COLUMN sandbox_template text;
