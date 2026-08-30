#!/usr/bin/env bash
set -euo pipefail

project_id="${GCP_PROJECT_ID:-seein-507115}"
zone="${GCP_ZONE:-asia-south1-a}"
instance="${GCP_INSTANCE:-seein-vm}"

gcloud compute instances reset "$instance" --project="$project_id" --zone="$zone" --quiet
echo "Reset ${instance}; it will pull the configured image tag during boot."
