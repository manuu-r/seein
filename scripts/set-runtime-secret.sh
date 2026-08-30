#!/usr/bin/env bash
set -euo pipefail

kind="${1:?Usage: scripts/set-runtime-secret.sh <gemini|firecrawl>}"
project_id="${GCP_PROJECT_ID:-seein-507115}"

case "$kind" in
  gemini) secret_id="seein-gemini-api-key" ;;
  firecrawl) secret_id="seein-firecrawl-api-key" ;;
  *)
    echo "Unknown secret kind: $kind (expected gemini or firecrawl)" >&2
    exit 2
    ;;
esac

read -r -s -p "Paste the ${kind} API key, then press Enter: " secret_value
printf '\n' >&2

if [[ -z "$secret_value" ]]; then
  echo "Secret value cannot be empty" >&2
  exit 2
fi

printf '%s' "$secret_value" | gcloud secrets versions add "$secret_id" --project="$project_id" --data-file=-
unset secret_value
echo "Added a new version of ${secret_id}."
