#!/usr/bin/env bash
# Throwaway environment per run.
#   up   — boot only (compose: unique project; process: own process group,
#          health_url REQUIRED; external: health check; none: marker only)
#   seed — run seed scripts and user data files; non-zero on any failure
#   down — compose down -v under the project / kill the process group;
#          removes run-env.json
# Boot and seed are separate so the caller arms a teardown trap in between.
set -e
SETUP=".verify/setup.json"
[ -f "$SETUP" ] || { echo "✗ .verify/setup.json not found. Run /verify-setup."; exit 1; }
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_CMD="timeout"
else echo "✗ timeout command not found. Install: brew install coreutils"; exit 1; fi

EXPAND="$(cd "$(dirname "$0")" && pwd)/expand.sh"

MODE=$(jq -r '.mode' "$SETUP")
CMD="${1:-up}"

# The env file is repo-controlled data, so it is PARSED (KEY=VALUE lines only),
# never sourced — sourcing would execute whatever the file contains. `down`
# skips it entirely: teardown must depend only on run-env.json, so a deleted
# or broken env file can never strand a running stack.
if [ "$CMD" != "down" ]; then
  if [ -n "${VERIFY_ENV_FILE:-}" ]; then
    # An explicit override is a promise, never silently substituted: a typo'd
    # path falling back to a stale shared env is a wrong-verdict machine.
    ENV_FILE="$VERIFY_ENV_FILE"
    [ -f "$ENV_FILE" ] || { echo "✗ VERIFY_ENV_FILE does not exist: $ENV_FILE"; exit 1; }
  else
    ENV_FILE="$(jq -r '.env_file // empty' "$SETUP")"
    if [ -n "$ENV_FILE" ] && [ ! -f "$ENV_FILE" ]; then
      STORE_ENV="$(bash "$(cd "$(dirname "$0")" && pwd)/shared-store.sh" path)/local.env"
      if [ -f "$STORE_ENV" ]; then
        echo "→ $ENV_FILE missing here (fresh worktree?) — using shared fallback: $STORE_ENV"
        ENV_FILE="$STORE_ENV"
      fi
    fi
  fi
  if [ -n "$ENV_FILE" ]; then
    [ -f "$ENV_FILE" ] || { echo "✗ configured env file missing: $ENV_FILE (no shared fallback either — run /verify-setup or shared-store.sh push from a checkout that has it)"; exit 1; }
    while IFS= read -r line || [ -n "$line" ]; do
      key="${line%%=*}"
      val="${line#*=}"
      case "$key" in
        *[!A-Za-z0-9_]*|""|[0-9]*) continue ;;
        PATH|IFS|ENV|BASH_ENV|SHELL|CDPATH|LD_*|DYLD_*|PS4|PROMPT_COMMAND|TMPDIR)
          echo "→ ignoring $key from env file — the verifier's own environment is not configurable from repo data"
          continue ;;
      esac
      [ "$line" = "$key" ] && continue            # no '=' present
      case "$val" in \"*\") val="${val#\"}"; val="${val%\"}" ;; esac   # strip only PAIRED quotes
      export "$key=$val"
    done < "$ENV_FILE"
  fi
fi

case "$CMD" in
  up)
    # One run per repo: cross-stage state (current-run, run-env.json) is
    # repo-global, so a second concurrent run would redirect this one.
    if ! mkdir .verify/run-lock 2>/dev/null; then
      echo "✗ Another verify run appears active (.verify/run-lock exists)."
      echo "  If it crashed, remove the lock: rmdir .verify/run-lock"
      exit 1
    fi
    # A failed boot must not strand the lock; a successful one keeps it until down.
    trap '[ "${UP_OK:-0}" = 1 ] || rmdir .verify/run-lock 2>/dev/null || true' EXIT
    rm -f .verify/compare.json   # a new run invalidates any old comparison
    # The run identity comes from half one (skill step 2 writes current-run);
    # a standalone boot (tests, compare) generates its own.
    if [ -f .verify/current-run ]; then
      RUN_ID="$(cat .verify/current-run)"
    else
      RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
      mkdir -p .verify
      printf '%s\n' "$RUN_ID" > .verify/current-run
    fi
    MARKER="verify-$RUN_ID"
    PROJECT="verify-$RUN_ID"
    mkdir -p ".verify/runs/$RUN_ID/evidence" ".verify/runs/$RUN_ID/tests"
    # Rotate: keep the newest 5 runs.
    ls -1dt .verify/runs/*/ 2>/dev/null | tail -n +6 | xargs rm -rf 2>/dev/null || true
    PGID=""

    case "$MODE" in
      compose)
        CF=$(jq -r '.compose_file' "$SETUP")
        echo "→ Booting throwaway stack (project $PROJECT)..."
        if ! docker compose -p "$PROJECT" -f "$CF" up -d --wait; then
          # A failed --wait can still have created containers; never leave a
          # uniquely-named orphan stack nothing can find later.
          docker compose -p "$PROJECT" -f "$CF" down -v 2>/dev/null || true
          echo "✗ Boot failed; partial stack removed."
          exit 1
        fi
        echo "✓ Stack up"
        ;;
      process)
        BOOT=$(jq -r '.boot' "$SETUP")
        HEALTH_URL=$(jq -r '.health_url // empty' "$SETUP" | bash "$EXPAND")
        [ -n "$HEALTH_URL" ] || { echo "✗ process mode requires health_url in setup.json"; exit 1; }
        echo "→ Starting: $BOOT"
        # Python is already required by the plugin and gives us a portable
        # setsid(2) call on both macOS and Linux.
        python3 -c 'import os, sys; os.setsid(); open(f".verify/process-{os.getpid()}.ready", "w").close(); os.execlp("bash", "bash", "-c", sys.argv[1])' \
          "$BOOT" > .verify/boot.log 2>&1 &
        PGID=$!
        READY_FILE=".verify/process-$PGID.ready"
        for ((i=0; i<50; i++)); do
          [ -f "$READY_FILE" ] && break
          kill -0 "$PGID" 2>/dev/null || break
          sleep 0.1
        done
        [ -f "$READY_FILE" ] || { echo "✗ Could not start process group (see .verify/boot.log)"; exit 1; }
        rm -f "$READY_FILE"
        OK=0
        for ((i=0; i<60; i++)); do
          kill -0 "$PGID" 2>/dev/null || break
          curl -sf --max-time 2 "$HEALTH_URL" > /dev/null 2>&1 && { OK=1; break; }
          sleep 1
        done
        [ "$OK" = "1" ] || { echo "✗ Never became healthy (see .verify/boot.log)"; kill -- "-$PGID" 2>/dev/null || true; exit 1; }
        echo "✓ Process up (pgid $PGID)"
        ;;
      external)
        BASE=$(jq -r '.base_url // empty' "$SETUP" | bash "$EXPAND")
        echo "⚠ External mode: reusing a running stack breaks isolation."
        [ -n "$BASE" ] && { curl -sf --max-time 5 "$BASE" > /dev/null || { echo "✗ $BASE unreachable"; exit 1; }; }
        ;;
      none)
        echo "→ Plain-command mode: no stack to boot."
        ;;
      *) echo "✗ Unknown mode: $MODE"; exit 1 ;;
    esac

    jq -n --arg r "$RUN_ID" --arg p "$PROJECT" --arg m "$MARKER" --arg g "$PGID" \
      '{run_id: $r, project: $p, marker: $m, pgid: (if $g == "" then null else ($g|tonumber) end)}' \
      > .verify/run-env.json
    UP_OK=1
    echo "✓ Environment ready (marker: $MARKER)"
    ;;
  seed)
    # Failure aborts — judging against a half-seeded database is how wrong
    # verdicts happen.
    while IFS= read -r s; do
      [ -n "$s" ] || continue
      echo "→ Seeding: $s"
      case "$s" in
        *.sql)
          DB_ENV=$(jq -r '.observe.db_url_env // empty' "$SETUP")
          if [ -n "$DB_ENV" ] && [ -n "${!DB_ENV:-}" ]; then
            "$TIMEOUT_CMD" 120 psql "${!DB_ENV}" -v ON_ERROR_STOP=1 -f "$s"
          else
            echo "✗ SQL seed needs observe.db_url_env resolvable from the env file"; exit 1
          fi ;;
        *.sh) "$TIMEOUT_CMD" 300 bash "$s" ;;
        *)
          if [ -x "$s" ]; then "$TIMEOUT_CMD" 300 "$s"
          else echo "✗ Don't know how to load seed input '$s' — wrap it in a .sh or .sql loader"; exit 1; fi ;;
      esac
    done < <(jq -r '.seed[]?, .seed_data_files[]?' "$SETUP")
    echo "✓ Seeded"
    ;;
  down)
    rmdir .verify/run-lock 2>/dev/null || true
    case "$MODE" in
      compose)
        CF=$(jq -r '.compose_file' "$SETUP")
        PROJECT=$(jq -r '.project // empty' .verify/run-env.json 2>/dev/null || echo "")
        if [ -n "$PROJECT" ]; then
          if ! docker compose -p "$PROJECT" -f "$CF" down -v; then
            echo "✗ Teardown failed — keeping .verify/run-env.json so it can be retried: docker compose -p $PROJECT -f $CF down -v"
            exit 1
          fi
        fi
        echo "✓ Stack removed (volumes included)"
        ;;
      process)
        PGID=$(jq -r '.pgid // empty' .verify/run-env.json 2>/dev/null || echo "")
        if [ -n "$PGID" ]; then
          kill -- "-$PGID" 2>/dev/null || true
          for ((i=0; i<10; i++)); do
            kill -0 -- "-$PGID" 2>/dev/null || break
            sleep 0.5
          done
          kill -9 -- "-$PGID" 2>/dev/null || true
        fi
        echo "✓ Process group stopped"
        ;;
      *) : ;;
    esac
    rm -f .verify/run-env.json
    ;;
  *) echo "usage: env.sh up|seed|down"; exit 1 ;;
esac
