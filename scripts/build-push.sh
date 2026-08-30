#!/usr/bin/env bash
set -euo pipefail

project_id="${GCP_PROJECT_ID:-seein-507115}"
region="${GCP_REGION:-asia-south1}"
repository="${GCP_REPOSITORY:-seein}"
tag="${1:-$(git rev-parse --short HEAD)}"
progress="${BUILDKIT_PROGRESS:-auto}"

if [[ ! "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "Invalid image tag: $tag" >&2
  exit 2
fi

case "$progress" in
  auto|plain|quiet|tty) ;;
  *)
    echo "Invalid BUILDKIT_PROGRESS value: $progress" >&2
    exit 2
    ;;
esac

image="${region}-docker.pkg.dev/${project_id}/${repository}/seein-core"

gcloud auth configure-docker "${region}-docker.pkg.dev" --quiet
docker buildx build \
  --progress "$progress" \
  --platform linux/amd64 \
  --file docker/core.Dockerfile \
  --tag "${image}:${tag}" \
  --tag "${image}:latest" \
  --push \
  .

echo "Pushed ${image}:${tag} and ${image}:latest"
