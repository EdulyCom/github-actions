#!/usr/bin/env bash
# Enable Cursor Bugbot on all github-actions consumers.
# Requires: CURSOR_API_KEY from https://cursor.com/dashboard/api
set -euo pipefail

: "${CURSOR_API_KEY:?Set CURSOR_API_KEY from https://cursor.com/dashboard/api}"

REPOS=(
  "https://github.com/EdulyCom/eduly"
  "https://github.com/EdulyCom/ezzu"
  "https://github.com/EdulyCom/infra-template"
  "https://github.com/EdulyCom/infra-payload"
  "https://github.com/Lagn-App/lagn"
  "https://github.com/aikstudio/aik"
)

for repoUrl in "${REPOS[@]}"; do
  echo "Enabling Bugbot for $repoUrl ..."
  curl -sS -X POST https://api.cursor.com/bugbot/repo/update \
    -H "Authorization: Bearer ${CURSOR_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"repoUrl\": \"${repoUrl}\", \"enabled\": true, \"manualTriggerOnly\": false}"
  echo
done

echo "Listing team Bugbot repos ..."
curl -sS https://api.cursor.com/bugbot/repos \
  -H "Authorization: Bearer ${CURSOR_API_KEY}"
echo
