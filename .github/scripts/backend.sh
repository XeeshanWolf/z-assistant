#!/usr/bin/env bash
# Sets up Z Assistant's Supabase project: database, login settings, reminder sender, app config.
# Safe to run on every deploy. Writes the result to _site/deploy-status.json.
set -uo pipefail
API=https://api.supabase.com/v1
AUTH=(-H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json")
STATUS=_site/deploy-status.json

fail() {
  jq -n --arg step "$1" --arg msg "$2" --arg when "$(date -u +%FT%TZ)" '{cloud:"error", step:$step, message:$msg, when:$when}' > "$STATUS"
  echo "::error::$1: $2"
  exit 1
}

projects=$(curl -sS "${AUTH[@]}" "$API/projects") || fail find-project "Could not reach Supabase."
echo "$projects" | jq -e 'type=="array"' >/dev/null 2>&1 || fail find-project "Supabase refused the token: $(echo "$projects" | head -c 300)"
REF="${SUPABASE_PROJECT_REF:-}"
[ -z "$REF" ] && REF=$(echo "$projects" | jq -r '[.[] | select((.name|ascii_downcase|gsub("[^a-z]";""))=="zassistant")][0].id // empty')
[ -z "$REF" ] && REF=$(echo "$projects" | jq -r 'if length==1 then .[0].id else empty end')
[ -z "$REF" ] && fail find-project "No Supabase project named z-assistant. Projects found: $(echo "$projects" | jq -c '[.[].name]')"
echo "Project: $REF"

for i in $(seq 1 36); do
  s=$(curl -sS "${AUTH[@]}" "$API/projects/$REF" | jq -r '.status // empty')
  [ "$s" = "ACTIVE_HEALTHY" ] && break
  echo "Waiting for project ($s)"; sleep 10
done
[ "$s" = "ACTIVE_HEALTHY" ] || fail wait "Project is not ready yet (status: $s). It will be set up on the next deploy."

sed "s/__REF__/$REF/g" supabase/schema.sql > /tmp/schema.sql
code=$(curl -sS -o /tmp/q.json -w '%{http_code}' -X POST "${AUTH[@]}" "$API/projects/$REF/database/query" --data "$(jq -Rs '{query: .}' /tmp/schema.sql)")
[[ "$code" =~ ^2 ]] || fail database "$code $(head -c 600 /tmp/q.json)"
echo "Database ready"

body=$(jq -n --arg site "$SITE_URL" '{mailer_autoconfirm: true, site_url: $site, uri_allow_list: ($site + "**")}')
code=$(curl -sS -o /tmp/a.json -w '%{http_code}' -X PATCH "${AUTH[@]}" "$API/projects/$REF/config/auth" --data "$body")
[[ "$code" =~ ^2 ]] || fail login-settings "$code $(head -c 600 /tmp/a.json)"
echo "Login settings ready"

if ! supabase functions deploy remind --project-ref "$REF" --no-verify-jwt --use-api --yes > /tmp/f.log 2>&1; then
  cat /tmp/f.log
  supabase functions deploy remind --project-ref "$REF" --no-verify-jwt --yes > /tmp/f.log 2>&1 || fail reminder-sender "$(tail -c 800 /tmp/f.log)"
fi
cat /tmp/f.log
echo "Reminder sender deployed"

keys=$(curl -sS "${AUTH[@]}" "$API/projects/$REF/api-keys?reveal=true")
KEY=$(echo "$keys" | jq -r '[.[]? | select(.type=="publishable")][0].api_key // empty')
[ -z "$KEY" ] && KEY=$(echo "$keys" | jq -r '[.[]? | select(.name=="anon")][0].api_key // empty')
[ -z "$KEY" ] && fail app-key "No public app key found: $(echo "$keys" | jq -c '[.[]? | {name,type}]' | head -c 300)"
printf 'window.Z_CONFIG={url:"https://%s.supabase.co",key:"%s"};\n' "$REF" "$KEY" > _site/config.js

sleep 5
vapid=$(curl -sS --max-time 40 "https://$REF.supabase.co/functions/v1/remind?vapid=1" || true)
ping=$(curl -sS --max-time 40 "https://$REF.supabase.co/functions/v1/remind" || true)
jq -n --arg ref "$REF" --arg vapid "$(echo "$vapid" | head -c 300)" --arg ping "$(echo "$ping" | head -c 300)" --arg when "$(date -u +%FT%TZ)" \
  '{cloud:"ok", project:$ref, reminder_sender:$ping, notification_key:($vapid|test("publicKey")), when:$when}' > "$STATUS"
cat "$STATUS"
