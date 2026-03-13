CREATE TABLE IF NOT EXISTS repo_configs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id   bigint REFERENCES github_installations(installation_id),
  owner             text NOT NULL,
  repo              text NOT NULL,
  startup_command   text NOT NULL,
  port              integer NOT NULL DEFAULT 3000,
  install_command   text,
  pre_start_script  text,
  health_path       text DEFAULT '/',
  test_email        text,
  test_password     text,
  env_vars          jsonb,
  detected_infra    jsonb DEFAULT '[]'::jsonb,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  UNIQUE (owner, repo)
);

CREATE INDEX IF NOT EXISTS idx_repo_configs_installation_id ON repo_configs (installation_id);
