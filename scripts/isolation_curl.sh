#!/bin/sh
# Isolation and Access-Control Verification Script via cURL
# Validates live endpoint boundaries (200, 401, 403, 404, 409) against Dogfood fixtures.
set -eu

BASE_URL="${1:-${BASE_URL:-http://localhost:8080}}"
EVENT_SLUG="sample-hack-2026"

ORG_COOKIE="manak_session=session_org_sample_hack"
JUDGE_A_COOKIE="manak_session=session_judge_a_sample_hack"
JUDGE_B_COOKIE="manak_session=session_judge_b_sample_hack"
PRT_COOKIE="manak_session=session_prt_sample_hack"

PASSED=0
FAILED=0

probe() {
  desc="$1"
  method="$2"
  url_path="$3"
  cookie="$4"
  body="$5"
  expected_status="$6"

  if [ -n "$cookie" ]; then
    if [ -n "$body" ]; then
      status=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" \
        -H "Cookie: $cookie" \
        -H "Content-Type: application/json" \
        -d "$body" \
        "${BASE_URL}${url_path}")
    else
      status=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" \
        -H "Cookie: $cookie" \
        "${BASE_URL}${url_path}")
    fi
  else
    if [ -n "$body" ]; then
      status=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" \
        -H "Content-Type: application/json" \
        -d "$body" \
        "${BASE_URL}${url_path}")
    else
      status=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" \
        "${BASE_URL}${url_path}")
    fi
  fi

  if [ "$status" = "$expected_status" ]; then
    printf "  [PASS] %-55s (HTTP %s)\n" "$desc" "$status"
    PASSED=$((PASSED + 1))
  else
    printf "  [FAIL] %-55s (expected %s, got %s)\n" "$desc" "$expected_status" "$status"
    FAILED=$((FAILED + 1))
  fi
}

echo "=== Manak Endpoint Isolation Probe Suite ==="
echo "Target Base URL: ${BASE_URL}"
echo "Target Event:    ${EVENT_SLUG}"
echo ""

# 1. Public Gallery / Project List
probe "Public: Gallery listing" "GET" "/api/events/${EVENT_SLUG}/projects" "" "" "200"

# 2. Closed Submission Window (Conflict)
probe "Participant: Submit project after deadline" "POST" "/api/events/${EVENT_SLUG}/projects" "$PRT_COOKIE" '{"title":"Late Entry","summary":"Attempt after deadline"}' "409"

# 3. Judge Queue (Self)
probe "Judge A: Inspect own scoring queue" "GET" "/api/events/${EVENT_SLUG}/judging" "$JUDGE_A_COOKIE" "" "200"

# 4. Peer Judge Isolation (Peer score inspection refused)
probe "Judge B: Inspect Judge A queue/scores" "GET" "/api/events/${EVENT_SLUG}/judging?judge=jdg_01" "$JUDGE_B_COOKIE" "" "403"

# 5. Role Boundary: Participant requesting Judge Queue
probe "Participant: Access judging queue" "GET" "/api/events/${EVENT_SLUG}/judging" "$PRT_COOKIE" "" "403"

# 6. Auth Boundary: Unauthenticated requesting Judge Queue
probe "Anonymous: Access judging queue" "GET" "/api/events/${EVENT_SLUG}/judging" "" "" "401"

# 7. CSV Export Permissions: Organizer
probe "Organizer: Download CSV audit export" "GET" "/api/events/${EVENT_SLUG}/csv/audit" "$ORG_COOKIE" "" "200"

# 8. CSV Export Permissions: Participant refused
probe "Participant: Download CSV audit export" "GET" "/api/events/${EVENT_SLUG}/csv/audit" "$PRT_COOKIE" "" "403"

# 9. CSV Export Permissions: Anonymous refused
probe "Anonymous: Download CSV audit export" "GET" "/api/events/${EVENT_SLUG}/csv/audit" "" "" "401"

# 10. Organizer Decision Support: Results Preflight
probe "Organizer: Results preflight check" "GET" "/api/events/${EVENT_SLUG}/results/preflight" "$ORG_COOKIE" "" "200"

# 11. Organizer Decision Support: Participant refused
probe "Participant: Results preflight check" "GET" "/api/events/${EVENT_SLUG}/results/preflight" "$PRT_COOKIE" "" "403"

# 12. Non-existent / Method mismatch / Fast-login probe
probe "Anonymous: Fast login endpoint not found" "GET" "/api/auth/fast-login" "" "" "404"

echo ""
echo "Summary: $PASSED passed, $FAILED failed"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
exit 0
