| AC | From | Intent | Base | Shows | Behaviour | Plain claim | How it is driven | Expect |
|----|------|--------|------|-------|-----------|-------------|------------------|--------|
| AC1 | Task 4 Interfaces: interval requeue 1h x 4^requeues, requeues < 3 | changes | not-applicable | success | Transient dead letters re-run exactly at the 1h, 4h, and 16h boundaries (time hacked by backdating) | A transient dead letter is re-run once about an hour after it died, again about four hours after the next death, and again after sixteen; one that is a minute short of each boundary is left alone. | Seed six transient dead letters with backdated death times (61m/59m at requeues 0, 4h01/3h59 at requeues 1, 16h01/15h59 at requeues 2), run the worker binary for 30s with the reaper ticking every 5s, read the six rows. | The three 'due' rows have requeues incremented by one and requeued_at set; the three 'short' rows are unchanged (same requeues, requeued_at NULL, status dead_letter). |
| AC2 | Decisions: needs_human is reserved for things the customer must act on, including a repository the worker cannot access | preserves | pass | success | A repository the worker cannot clone is still a needs_human incident with repo_access_denied | With a real sandbox but no GitHub credential, a private repository cannot be cloned, and the incident lands in needs_human for the customer with the repo_access_denied reason. | Wait for the seeded job on the private <private-repo> project, run the worker binary for 200s with real E2B and model keys but GITHUB_TOKEN unset, read the group and job. | Group status needs_human, reason_code repo_access_denied, needs_human_at set; job completed (not dead-lettered), attempts 0. |
| AC3 | Task 7 smoke step 4; Tasks 1 and 2 | changes | fail | success | A real investigation capped at one turn ends in one execution, labelled limit or agent, with the incident still in analyzing | When the model runs out of room on a real investigation of a real repository, the job is not retried, the incident is not shown to the customer, and the failure is labelled as ours. | Wait for the seeded job, run the worker binary for 300s with real E2B, model, and GitHub credentials and FRICTION_INVESTIGATION_MAX_TURNS=1, read the group and job. | Either group awaiting_approval with a verdict, or: job dead_letter, attempts 1, dead_letter_class limit or agent, group analyzing, reason_code NULL. The worker output has no 'Friction investigation API call failed' line and no 'retry the job'. Report which class was observed. |
| AC4 | Task 2 steps 3 and 5: transient failures use the queue's backoff; no insufficient_context or unable_to_establish_cause write | changes | fail | success | A provider outage retries through the queue and never becomes a customer verdict | If the model provider answers 529 to every call, the job is retried with backoff and finally dead-lettered as transient; the incident is never written to the customer as an evidence verdict. | Wait for the seeded job, run the worker binary for 480s with ANTHROPIC_BASE_URL pointing at a local stub that always answers 529 (real E2B and GitHub credentials), read the job and group. | attempts >= 2 within the window (3 and status dead_letter with dead_letter_class transient if the provider retries fit); the group is analyzing with reason_code NULL and no decision row written; last_error names the 529 or 'model unavailable'. |
| AC5 | Task 6 step 3 acceptance | changes | unknown | success | The route classifier completes on a real Vue repository and writes one route_map row per discovered route | The daily route map for a real app finishes within its (route-scaled) budget instead of dying, and every discovered route gets a row. | Wait for the seeded route_map job for the papermark project, run the worker binary for 480s with real credentials, read the job and the route_map rows, compare against the independently listed page files. | Job completed (not dead_letter). route_map rows for project ...0020 number between 40 and 120, against 80 page files (7 app-router page.tsx plus pages/*.tsx excluding api, _app, _document) listed independently in expected-routes.txt; the worker's 'Product context persisted' line agrees with the row count. A count of 0 or 1, or a dead letter on budget, fails. |

Unknown against the base commit. Confirm before approving:
- AC5: The route classifier completes on a real Vue repository and writes one route_map row per discovered route

What these criteria prove

            preserves  changes
  success           1        4
  refusal           0        0

Before judging, these parts get one pipeline check each
- AC1 relies on: db — proof it ran: marker-in-data (the six groups are titled with the run marker and returned with their counters)
- AC2 relies on: db — proof it ran: marker-in-data (the group is titled with the run marker and returned with its terminal fields)
- AC3 relies on: db — proof it ran: marker-in-data (the group title carries the marker and is read with the job row after the run)
- AC4 relies on: db — proof it ran: marker-in-data (the group title carries the marker and is read with the job row after the run)
- AC5 relies on: db — proof it ran: live-read (route_map rows and the job status are read after the run; the worker's persisted-count log line is in the run output)

Drive plans (what will actually run)
AC1:
  1. run timeout 30 env DATABASE_URL=postgres://opslane:<password>@localhost:5473/opslane?sslmode=disable HEALTH_PORT=8181 POLL_INTERVAL_MS=1000 USAGE_EVENTS_SLACK_WEBHOOK=http://127.0.0.1:8790/hook OPSLANE_E2B_JAVASCRIPT_TEMPLATE=<e2b-template> REAPER_INTERVAL_MS=5000 node packages/worker/dist/index.js --expect-exit 124 (timeout: 60s)
  2. db SELECT g.title, j.status, j.requeues, j.requeued_at IS NOT NULL AS requeued FROM error_group_jobs j JOIN error_groups g ON g.id = j.error_group_id WHERE g.title LIKE 'AC1 {{marker}} %' ORDER BY g.title
  proof: step 2 output must contain the marker
AC2:
  1. wait --sql SELECT count(*) FROM error_group_jobs j LEFT JOIN error_groups g ON g.id = j.error_group_id WHERE g.title = 'AC2 {{marker}}' AND j.available_at <= now() --contains 1 --timeout 1500 (timeout: 1510s)
  2. run timeout 200 env -u GITHUB_TOKEN DATABASE_URL=postgres://opslane:<password>@localhost:5473/opslane?sslmode=disable HEALTH_PORT=8181 POLL_INTERVAL_MS=1000 USAGE_EVENTS_SLACK_WEBHOOK=http://127.0.0.1:8790/hook OPSLANE_E2B_JAVASCRIPT_TEMPLATE=<e2b-template> node packages/worker/dist/index.js --expect-exit 124 (timeout: 230s)
  3. db SELECT g.title, g.status, g.reason_code, g.needs_human_at IS NOT NULL AS has_needs_human_at, j.status AS job_status, j.attempts, j.dead_letter_class, left(j.last_error, 100) AS last_error FROM error_groups g JOIN error_group_jobs j ON j.error_group_id = g.id WHERE g.title = 'AC2 {{marker}}'
  proof: step 3 output must contain the marker
AC3:
  1. wait --sql SELECT count(*) FROM error_group_jobs j LEFT JOIN error_groups g ON g.id = j.error_group_id WHERE g.title = 'AC3 {{marker}}' AND j.available_at <= now() --contains 1 --timeout 1500 (timeout: 1510s)
  2. run timeout 300 env DATABASE_URL=postgres://opslane:<password>@localhost:5473/opslane?sslmode=disable HEALTH_PORT=8181 POLL_INTERVAL_MS=1000 USAGE_EVENTS_SLACK_WEBHOOK=http://127.0.0.1:8790/hook OPSLANE_E2B_JAVASCRIPT_TEMPLATE=<e2b-template> FRICTION_INVESTIGATION_MAX_TURNS=1 node packages/worker/dist/index.js --expect-exit 124 (timeout: 330s)
  3. db SELECT g.title, g.status, g.reason_code, j.status AS job_status, j.attempts, j.dead_letter_class, j.requeues, left(j.last_error, 120) AS last_error FROM error_groups g JOIN error_group_jobs j ON j.error_group_id = g.id WHERE g.title = 'AC3 {{marker}}'
  proof: step 3 output must contain the marker
AC4:
  1. wait --sql SELECT count(*) FROM error_group_jobs j LEFT JOIN error_groups g ON g.id = j.error_group_id WHERE g.title = 'AC4 {{marker}}' AND j.available_at <= now() --contains 1 --timeout 1500 (timeout: 1510s)
  2. run timeout 480 env DATABASE_URL=postgres://opslane:<password>@localhost:5473/opslane?sslmode=disable HEALTH_PORT=8181 POLL_INTERVAL_MS=1000 USAGE_EVENTS_SLACK_WEBHOOK=http://127.0.0.1:8790/hook OPSLANE_E2B_JAVASCRIPT_TEMPLATE=<e2b-template> ANTHROPIC_BASE_URL=http://127.0.0.1:8791 node packages/worker/dist/index.js --expect-exit 124 (timeout: 510s)
  3. db SELECT g.title, g.status, g.reason_code, j.status AS job_status, j.attempts, j.dead_letter_class, left(j.last_error, 120) AS last_error, (SELECT count(*) FROM diagnosis_decisions dd WHERE dd.error_group_id = g.id) AS decisions FROM error_groups g JOIN error_group_jobs j ON j.error_group_id = g.id WHERE g.title = 'AC4 {{marker}}'
  proof: step 3 output must contain the marker
AC5:
  1. wait --sql SELECT count(*) FROM error_group_jobs j LEFT JOIN error_groups g ON g.id = j.error_group_id WHERE j.job_type = 'route_map' AND j.project_id = '00000000-0000-0000-0000-000000000020' AND j.available_at <= now() --contains 1 --timeout 1500 (timeout: 1510s)
  2. run timeout 480 env DATABASE_URL=postgres://opslane:<password>@localhost:5473/opslane?sslmode=disable HEALTH_PORT=8181 POLL_INTERVAL_MS=1000 USAGE_EVENTS_SLACK_WEBHOOK=http://127.0.0.1:8790/hook OPSLANE_E2B_JAVASCRIPT_TEMPLATE=<e2b-template> node packages/worker/dist/index.js --expect-exit 124 (timeout: 510s)
  3. db SELECT j.job_type, j.status, j.attempts, j.dead_letter_class, left(j.last_error, 120) AS last_error, (SELECT count(*) FROM route_map rm WHERE rm.project_id = j.project_id) AS route_rows FROM error_group_jobs j WHERE j.job_type = 'route_map' AND j.project_id = '00000000-0000-0000-0000-000000000020'
  proof: judged

No criterion covers: docs/superpowers/plans/2026-09-02-investigation-failure-classification.md

