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

MODE=$(jq -r '.mode' "$SETUP")
ENV_FILE="${VERIFY_ENV_FILE:-$(jq -r '.env_file // empty' "$SETUP")}"
if [ -n "$ENV_FILE" ]; then
  [ -f "$ENV_FILE" ] || { echo "✗ configured env file missing: $ENV_FILE"; exit 1; }
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
CMD="${1:-up}"

case "$CMD" in
  up)
    RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
    MARKER="verify-$RUN_ID"
    PROJECT="verify-$RUN_ID"
    mkdir -p ".verify/runs/$RUN_ID/evidence"
    # Repoint the evidence symlink so every existing script path still works.
    rm -rf .verify/evidence 2>/dev/null || true
    ln -sfn "runs/$RUN_ID/evidence" .verify/evidence
    # Rotate: keep the newest 5 runs.
    ls -1dt .verify/runs/*/ 2>/dev/null | tail -n +6 | xargs rm -rf 2>/dev/null || true
    PGID=""

    case "$MODE" in
      compose)
        CF=$(jq -r '.compose_file' "$SETUP")
        echo "→ Booting throwaway stack (project $PROJECT)..."
        docker compose -p "$PROJECT" -f "$CF" up -d --wait
        echo "✓ Stack up"
        ;;
      process)
        BOOT=$(jq -r '.boot' "$SETUP")
        HEALTH_URL=$(jq -r '.health_url // empty' "$SETUP")
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
        BASE=$(jq -r '.base_url // empty' "$SETUP")
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
        *) "$TIMEOUT_CMD" 300 bash -c "$s" ;;
      esac
    done < <(jq -r '.seed[]?, .seed_data_files[]?' "$SETUP")
    echo "✓ Seeded"
    ;;
  down)
    case "$MODE" in
      compose)
        CF=$(jq -r '.compose_file' "$SETUP")
        PROJECT=$(jq -r '.project // empty' .verify/run-env.json 2>/dev/null || echo "")
        [ -n "$PROJECT" ] && docker compose -p "$PROJECT" -f "$CF" down -v || true
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
