#!/usr/bin/env bash
set -euo pipefail

tag="${1:?Usage: scripts/deploy-vm.sh <image-tag>}"
project_id="${GCP_PROJECT_ID:-seein-507115}"
zone="${GCP_ZONE:-asia-south1-a}"
instance="${GCP_INSTANCE:-seein-vm}"

if [[ ! "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "Invalid image tag: $tag" >&2
  exit 2
fi

gcloud compute ssh "$instance" \
  --project="$project_id" \
  --zone="$zone" \
  --tunnel-through-iap \
  --command="sudo /usr/local/bin/seein-deploy '$tag'"
