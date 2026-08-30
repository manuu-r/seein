# SeeIn Google Cloud infrastructure

This configuration creates the SeeIn deployment: an IAP-protected Cloud Run
gateway, an HTTPS load balancer, and a private Compute Engine worker. The VM
runs the long-running workflow, Playwright, local project artifacts, and
ClickHouse; it has no public application firewall rule.

## Apply the infrastructure

```bash
terraform init \
  -backend-config="bucket=seein-507115-tfstate" \
  -backend-config="prefix=seein/terraform"
terraform apply
```

Terraform outputs `load_balancer_ip`. Create this DNS record at the domain
provider before expecting the managed certificate to become active:

```text
seein.maybecoded.com.  A  <load_balancer_ip>
```

## One-time IAP setup

IAP is enabled directly on Cloud Run, which protects both the Cloud Run URL and
traffic forwarded by the HTTPS load balancer. External Google accounts require
a custom OAuth configuration; its secret is intentionally not in Terraform
state.

1. Open **Cloud Run → seein-gateway → Security**.
2. Select **Require authentication → Identity-Aware Proxy (IAP)** and save.
3. For an external/no-organization project, choose **Configure in IAP** and
   use **Auto generate credentials**. Configure the External OAuth brand first
   if the console requests it.
4. Verify the service reports IAP enabled:

```bash
gcloud beta run services describe seein-gateway \
  --project=seein-507115 \
  --region=asia-south1
```

The Terraform IAP policy permits only the `seein-access@googlegroups.com`
Google Group. Manage its membership in Google Groups to grant or revoke user
access without rebuilding SeeIn.

The currently pinned Terraform Google provider cannot represent Cloud Run's
direct-IAP field. Terraform intentionally ignores the gateway service after
creation so it cannot clear this console-managed security setting. The release
script verifies that IAP remains enabled after every image update.

## First application release

The internal ClickHouse password is generated directly into Secret Manager.
Add the two provider keys without placing them in `.env` or source control:

```bash
scripts/set-runtime-secret.sh gemini
scripts/set-runtime-secret.sh firecrawl
```

Each command prompts silently for the key and creates a new secret version.
Then publish and deploy an immutable image tag:

```bash
scripts/build-push.sh <tag>
scripts/deploy-cloudrun.sh <tag>
```

`deploy-cloudrun.sh` updates the VM worker first, then the Cloud Run gateway,
and fails if direct IAP is no longer enabled. Roll back by redeploying an
earlier Artifact Registry tag:

```bash
scripts/deploy-cloudrun.sh <previous-tag>
```
