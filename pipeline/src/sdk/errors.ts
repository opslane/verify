export enum SetupError {
  // SQL errors (returned by run_sql tool)
  SQL_SYNTAX = "sql_syntax",
  FK_VIOLATION = "fk_violation",
  UNIQUE_VIOLATION = "unique_violation",
  COLUMN_NOT_FOUND = "column_not_found",
  TABLE_NOT_FOUND = "table_not_found",
  SEED_MUTATION_BLOCKED = "seed_mutation_blocked",
  DDL_BLOCKED = "ddl_blocked",
  DELETE_NO_WHERE = "delete_no_where",
  QUERY_TIMEOUT = "query_timeout",
  DB_CONNECTION = "db_connection",

  // SDK/agent errors
  EMPTY_RESPONSE = "empty_response",
  MAX_TURNS = "max_turns",
  PARSE_ERROR = "parse_error",
  SCHEMA_ERROR = "schema_error",
  TIMEOUT = "timeout",
  AUTH_ERROR = "auth_error",
  SPAWN_ERROR = "spawn_error",
}

const PG_ERROR_MAP: Record<string, SetupError> = {
  "42601": SetupError.SQL_SYNTAX,
  "23503": SetupError.FK_VIOLATION,
  "23505": SetupError.UNIQUE_VIOLATION,
  "42703": SetupError.COLUMN_NOT_FOUND,
  "42P01": SetupError.TABLE_NOT_FOUND,
};

export function classifyPgError(code: string | undefined): SetupError {
  if (!code) return SetupError.DB_CONNECTION;
  return PG_ERROR_MAP[code] ?? SetupError.SQL_SYNTAX;
}

// ── Planner SDK errors ───────────────────────────────────────────────────────

export enum PlannerError {
  EMPTY_RESPONSE = "empty_response",
  PARSE_ERROR = "parse_error",
  TIMEOUT = "timeout",
  MAX_TURNS = "max_turns",
  SPAWN_ERROR = "spawn_error",
}
