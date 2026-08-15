# Cloud deployment

Cloud deployment is intentionally a second phase. The workflow state machine and scene contracts should not change; cloud work replaces infrastructure adapters and run dispatch.

| Local | Cloud |
|---|---|
| Core API container | Cloud Run service |
| In-process execution | Cloud Run job per run |
| Local ClickHouse | ClickHouse Cloud |
| Local disk artifacts | Google Cloud Storage |
| Local secrets | Secret Manager |
| Local images | Artifact Registry |

The Cloud Run service creates a run and triggers a job. The job uses ephemeral scratch space, uploads every durable artifact to Cloud Storage, and records object keys and hashes in ClickHouse Cloud. Blender, Xvfb, Qwen-MM MCP, and Chromium remain bundled with the worker rather than becoming additional managed APIs.

The renderer receives API-proxied or short-lived signed URLs. A scene manifest remains independent of whether an asset URL resolves to local disk or Cloud Storage.

## Target topology

Use two Google Cloud workloads:

1. A small Cloud Run service exposes the API, validates requests, reads status, and starts jobs. It must not run Blender work in the request lifecycle.
2. A Cloud Run Job runs one bounded workflow per execution. The image is the same core image containing Qwen-MM, Blender, Xvfb, and Chromium. Set task timeout and memory for the maximum planned asset count.

ClickHouse Cloud is the shared context/lineage plane. Google Cloud Storage is the durable binary plane. Gemini remains the only remote model API.

```text
client -> Cloud Run API -> Cloud Run Job
                            |-> Gemini API
                            |-> ClickHouse Cloud
                            |-> Cloud Storage
                            `-> local Blender/Xvfb/Chromium inside job
```

## Required adapter work

The local MVP already depends on an `ArtifactStore` interface. Before deployment, add:

- `GcsArtifactStore`: write JSON, text, GLBs, references, and screenshots to object keys; return content hashes and API-safe URLs.
- `RunDispatcher`: in-process implementation locally, Cloud Run Jobs implementation in the API service.
- A lease/idempotency record in ClickHouse keyed by `run_id`, preventing duplicate job execution after retries.
- Signed-URL or authenticated proxy support for renderer assets. Do not put permanent public bucket URLs into manifests.

No Gemini, planning, Blender, scene, or QA code should contain Google Cloud SDK calls.

## ClickHouse Cloud

Create one database and apply the existing idempotent migration. Configure the job and API with:

```env
CONTEXT_DRIVER=clickhouse
CLICKHOUSE_URL=https://<service>.<region>.gcp.clickhouse.cloud:8443
CLICKHOUSE_DATABASE=seein
CLICKHOUSE_USERNAME=<service-user>
CLICKHOUSE_PASSWORD=<secret>
```

Use TLS, a dedicated least-privilege service account, and network allowlisting where available. Binary data stays in Cloud Storage; ClickHouse rows keep object keys, hashes, dimensions, tags, relationships, revisions, and timestamps.

## Google Cloud resources

Provision at minimum:

- Artifact Registry repository for the amd64 worker image.
- Cloud Storage bucket with uniform bucket-level access, lifecycle rules for scratch/reference data, and object versioning if revision recovery matters.
- Secret Manager entries for `GEMINI_API_KEY` and ClickHouse credentials.
- Cloud Run API service with no Blender dependencies in its active request path.
- Cloud Run Job using the core image, writable `/tmp`, adequate memory, and a timeout above the backend's bounded MCP timeout.
- Two service accounts: API may start jobs and read status; worker may read secrets and access only its artifact bucket.

The current worker image explicitly targets `linux/amd64`. Confirm that the selected Cloud Run execution environment accepts the image architecture before rollout.

## Deployment sequence

1. Build and push the pinned core image to Artifact Registry.
2. Create ClickHouse Cloud credentials and run `node dist/server/cli.js migrate` against the cloud URL from a controlled environment.
3. Implement and test `GcsArtifactStore` with a non-production bucket.
4. Deploy the Cloud Run Job and invoke one deterministic-AI smoke run; verify GLBs and screenshots land in the bucket.
5. Deploy the API service and job dispatcher; verify create/status/events/view endpoints.
6. Enable Gemini, run one grounded production prompt, and verify source/reference artifacts plus multimodal QA.
7. Run the identical prompt again and require a research cache hit and corrected asset reuse before production promotion.

## Reliability and security gates

- Treat Cloud Run Job retries as duplicate delivery; all writes must be idempotent by run/revision key.
- Keep the one-patch refinement bound and object/reference limits in server configuration.
- Use signed URLs with short expiry or API proxying; never expose ClickHouse or Gemini credentials to the renderer.
- Retain event rows and final manifests longer than transient screenshots or downloaded references.
- Emit structured logs with `project_id`, `run_id`, stage, and revision but never prompts or secrets by default in production telemetry.
- Add budget alerts for Gemini, Cloud Run compute, Cloud Storage egress, and ClickHouse Cloud.
