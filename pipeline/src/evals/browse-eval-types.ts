export interface BrowseScriptStep {
  match: string;
  stdout?: string;
  stderr?: string;
  exitCode: number;
  sleepMs?: number;
}

export interface BrowseScript {
  steps: BrowseScriptStep[];
}

export interface BrowseTraceEntry {
  ts: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface BrowseEvalExpectation {
  ac_id: string;
  expect_parseable_result: boolean;
  expect_result_kind: "normal" | "nav_failure";
  expect_nav_failure_kind?: "navigation" | "interaction";
  required_commands: string[];
  required_evidence_substrings?: string[];
  forbidden_shell_patterns: string[];
  required_observed_substrings: string[];
  forbidden_observed_substrings: string[];
  allowed_read_path_suffixes?: string[];
  max_command_count: number;
  max_duration_ms: number;
}
