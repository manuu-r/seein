#!/usr/bin/env bash
set -euo pipefail

tag="${1:?Usage: scripts/deploy-cloudrun.sh <image-tag>}"
project_id="${GCP_PROJECT_ID:-seein-507115}"
region="${GCP_REGION:-asia-south1}"
repository="${GCP_REPOSITORY:-seein}"
service="${CLOUD_RUN_SERVICE:-seein-gateway}"

if [[ ! "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "Invalid image tag: $tag" >&2
  exit 2
fi

image="${region}-docker.pkg.dev/${project_id}/${repository}/seein-core:${tag}"

# The VM is the long-running worker and must be updated before the public
# Cloud Run gateway exposes a revision that expects the corresponding API.
"$(dirname "$0")/deploy-vm.sh" "$tag"

gcloud run services update "$service" \
  --project="$project_id" \
  --region="$region" \
  --image="$image" \
  --quiet

if ! gcloud run services describe "$service" \
  --project="$project_id" \
  --region="$region" \
  --format=export | grep -Fq "run.googleapis.com/iap-enabled: 'true'"; then
  echo "Cloud Run IAP is not enabled; refusing to report a successful deployment." >&2
  echo "Enable IAP in Cloud Run > ${service} > Security before retrying." >&2
  exit 1
fi

gcloud run services describe "$service" \
  --project="$project_id" \
  --region="$region" \
  --format='value(status.latestReadyRevisionName)'

echo "Deployed ${image}: VM worker and Cloud Run gateway are updated."
