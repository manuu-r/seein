# SeeIn Google Cloud infrastructure

This configuration creates the initial Compute Engine deployment, Artifact
Registry repository, Secret Manager containers, and an IAP-ready HTTPS load
balancer. The VM has no public application firewall rule.

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

## One-time External OAuth setup

External Google accounts require a custom IAP OAuth configuration. This cannot
be safely placed in Terraform because it would put the generated OAuth secret
in Terraform state.

1. Open the `iap_console_url` Terraform output.
2. Configure OAuth branding with **SeeIn**, `manu490.rm@gmail.com` as support
   and contact email, and **External** as the audience. Google Auth Platform
   requires a public SeeIn homepage and privacy-policy URL on a domain verified
   in Google Search Console. They cannot be behind IAP.
3. In IAP, select `seein-iap-backend`, open **Settings**, select **Custom
   OAuth**, then choose **Auto Generate Credentials** and save.
4. Confirm IAP is enabled for the backend service.
5. Apply the backend firewall rule only after the prior step:

```bash
terraform apply -var='enable_iap_backend_ingress=true'
```

The IAP policy permits only the `seein-access@googlegroups.com` Google Group.
Manage its membership in Google Groups to grant or revoke user access without
rebuilding SeeIn.

## First application release

The internal ClickHouse password is generated directly into Secret Manager.
Add the two provider keys without placing them in `.env` or source control:

```bash
scripts/set-runtime-secret.sh gemini
scripts/set-runtime-secret.sh firecrawl
```

Each command prompts silently for the key and creates a new secret version.
Then start the initial `latest` image:

```bash
scripts/restart-vm.sh
```

For subsequent releases, publish an immutable tag and deploy it directly:

```bash
scripts/build-push.sh <tag>
scripts/deploy-vm.sh <tag>
```
