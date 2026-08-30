provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  required_services = toset([
    "artifactregistry.googleapis.com",
    "compute.googleapis.com",
    "iap.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
  ])
  registry_host = "${var.region}-docker.pkg.dev"
  registry_path = "${local.registry_host}/${var.project_id}/seein/seein-core"
}

resource "google_project_service" "required" {
  for_each           = local.required_services
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "seein" {
  project       = var.project_id
  location      = var.region
  repository_id = "seein"
  description   = "Immutable SeeIn container images"
  format        = "DOCKER"

  depends_on = [google_project_service.required]
}

resource "google_service_account" "vm" {
  project      = var.project_id
  account_id   = "seein-vm"
  display_name = "SeeIn VM runtime"
}

resource "google_service_account" "gateway" {
  project      = var.project_id
  account_id   = "seein-gateway"
  display_name = "SeeIn Cloud Run gateway"
}

resource "google_artifact_registry_repository_iam_member" "vm_reader" {
  project    = var.project_id
  location   = google_artifact_registry_repository.seein.location
  repository = google_artifact_registry_repository.seein.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.vm.email}"
}

resource "google_secret_manager_secret" "runtime" {
  for_each = toset([
    "seein-gemini-api-key",
    "seein-firecrawl-api-key",
    "seein-clickhouse-password",
  ])

  project   = var.project_id
  secret_id = each.value

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_iam_member" "vm_accessor" {
  for_each = google_secret_manager_secret.runtime

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vm.email}"
}

resource "google_compute_network" "seein" {
  project                 = var.project_id
  name                    = "seein-network"
  auto_create_subnetworks = false

  depends_on = [google_project_service.required]
}

resource "google_compute_subnetwork" "seein" {
  project       = var.project_id
  name          = "seein-subnet"
  region        = var.region
  network       = google_compute_network.seein.id
  ip_cidr_range = "10.20.0.0/24"
}

resource "google_compute_address" "seein" {
  project      = var.project_id
  name         = "seein-ip"
  region       = var.region
  address_type = "EXTERNAL"
  network_tier = "PREMIUM"

  depends_on = [google_project_service.required]
}

# Administration is available only through Identity-Aware Proxy. The application
# itself has no public firewall rule until authentication/rate limiting are added.
resource "google_compute_firewall" "iap_ssh" {
  project       = var.project_id
  name          = "seein-allow-iap-ssh"
  network       = google_compute_network.seein.name
  direction     = "INGRESS"
  priority      = 1000
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["seein-vm"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# The user-facing Cloud Run gateway has a revision-level network tag. This is
# the sole ingress path to the VM application; ClickHouse has no host port.
resource "google_compute_firewall" "gateway_to_worker" {
  project     = var.project_id
  name        = "seein-allow-gateway-to-worker"
  network     = google_compute_network.seein.name
  direction   = "INGRESS"
  priority    = 1000
  source_tags = ["seein-gateway"]
  target_tags = ["seein-vm"]

  allow {
    protocol = "tcp"
    ports    = [tostring(var.app_port)]
  }
}

# Retained during migration so the existing IAP backend stays healthy until the
# Cloud Run backend has an independent custom OAuth configuration.
resource "google_compute_firewall" "load_balancer_to_app" {
  count = var.keep_vm_backend ? 1 : 0

  project       = var.project_id
  name          = "seein-allow-load-balancer"
  network       = google_compute_network.seein.name
  direction     = "INGRESS"
  priority      = 1000
  source_ranges = ["130.211.0.0/22", "35.191.0.0/16"]
  target_tags   = ["seein-vm"]

  allow {
    protocol = "tcp"
    ports    = [tostring(var.app_port)]
  }
}

# Direct VPC egress needs the Cloud Run service agent to attach revisions to
# this subnet. It avoids an always-on Serverless VPC Access connector.
data "google_project" "current" {
  project_id = var.project_id
}

resource "google_compute_subnetwork_iam_member" "cloud_run_network_user" {
  project    = var.project_id
  region     = google_compute_subnetwork.seein.region
  subnetwork = google_compute_subnetwork.seein.name
  role       = "roles/compute.networkUser"
  member     = "serviceAccount:service-${data.google_project.current.number}@serverless-robot-prod.iam.gserviceaccount.com"

  depends_on = [google_project_service.required]
}

resource "google_compute_instance" "seein" {
  project      = var.project_id
  name         = "seein-vm"
  zone         = var.zone
  machine_type = var.machine_type
  tags         = ["seein-vm"]

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = var.boot_disk_size_gb
      type  = "pd-ssd"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.seein.id
    access_config {
      nat_ip = google_compute_address.seein.address
    }
  }

  metadata = {
    enable-oslogin = "TRUE"
  }

  metadata_startup_script = templatefile("${path.module}/startup.sh.tftpl", {
    project_id    = var.project_id
    registry_host = local.registry_host
    registry_path = local.registry_path
    app_port      = var.app_port
    app_domain    = var.app_domain
    compose_file  = file("${path.module}/../../docker-compose.prod.yml")
  })

  service_account {
    email  = google_service_account.vm.email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  allow_stopping_for_update = true

  # The Google provider treats startup-script changes as ForceNew. Update the
  # existing VM's metadata in place through the deployment procedure instead of
  # replacing its persistent disk and ClickHouse data.
  lifecycle {
    ignore_changes = [metadata_startup_script]
  }

  depends_on = [
    google_artifact_registry_repository_iam_member.vm_reader,
    google_secret_manager_secret_iam_member.vm_accessor,
  ]
}

resource "google_compute_instance_group" "seein" {
  project   = var.project_id
  name      = "seein-backend-group"
  zone      = var.zone
  instances = [google_compute_instance.seein.self_link]

  named_port {
    name = "http"
    port = var.app_port
  }
}

resource "google_compute_health_check" "seein" {
  project             = var.project_id
  name                = "seein-http-health"
  check_interval_sec  = 5
  timeout_sec         = 3
  healthy_threshold   = 2
  unhealthy_threshold = 3

  http_health_check {
    port         = var.app_port
    request_path = "/health"
  }
}

resource "google_cloud_run_v2_service" "gateway" {
  project  = var.project_id
  name     = "seein-gateway"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  # Direct Cloud Run IAP was enabled once in the console to generate the
  # project OAuth client. The pinned Google provider does not yet expose this
  # field, but subsequent image rollouts preserve it.

  template {
    service_account                  = google_service_account.gateway.email
    max_instance_request_concurrency = 80

    scaling {
      max_instance_count = 3
    }

    containers {
      image   = "${local.registry_path}:latest"
      command = ["node"]
      args    = ["dist/server/gateway.js"]

      ports {
        container_port = 8080
      }

      env {
        name  = "UPSTREAM_BASE_URL"
        value = "http://${google_compute_instance.seein.network_interface[0].network_ip}:${var.app_port}"
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"

      network_interfaces {
        network    = google_compute_network.seein.id
        subnetwork = google_compute_subnetwork.seein.id
        tags       = ["seein-gateway"]
      }
    }
  }

  # Direct Cloud Run IAP is not represented by the pinned Google provider; a
  # provider service update would otherwise remove its console-managed setting.
  # The deployment script updates the image while preserving all other service
  # settings. Change service infrastructure deliberately through gcloud until
  # the provider can manage iap_enabled.
  lifecycle {
    ignore_changes = all
  }

  depends_on = [
    google_compute_subnetwork_iam_member.cloud_run_network_user,
    google_project_service.required,
  ]
}

# IAP is enforced directly by Cloud Run for every ingress path, including
# requests forwarded by the HTTPS load balancer. Only the IAP service agent may
# invoke the application container.
resource "google_cloud_run_v2_service_iam_member" "gateway_invoker" {
  project  = var.project_id
  location = google_cloud_run_v2_service.gateway.location
  name     = google_cloud_run_v2_service.gateway.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-iap.iam.gserviceaccount.com"
}

resource "google_compute_region_network_endpoint_group" "gateway" {
  project               = var.project_id
  name                  = "seein-gateway-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.gateway.name
  }
}

resource "google_compute_backend_service" "seein" {
  project               = var.project_id
  name                  = "seein-iap-backend"
  protocol              = "HTTP"
  port_name             = "http"
  timeout_sec           = 60
  load_balancing_scheme = "EXTERNAL"
  health_checks         = [google_compute_health_check.seein.id]

  backend {
    group = google_compute_instance_group.seein.self_link
  }

  # IAP is enabled through the console after the external OAuth consent screen
  # and IAP-generated client are created. The OAuth secret must not enter state.
  lifecycle {
    ignore_changes = [iap]
  }
}

# A VM backend service that ever had timeoutSec cannot be converted to a
# serverless NEG, so this is a separate backend for the Cloud Run gateway.
# IAP is configured directly on the Cloud Run service, not here.
resource "google_compute_backend_service" "gateway" {
  project               = var.project_id
  name                  = "seein-iap-gateway"
  protocol              = "HTTP"
  load_balancing_scheme = "EXTERNAL"

  backend {
    group = google_compute_region_network_endpoint_group.gateway.id
  }

}

resource "google_iap_web_backend_service_iam_member" "access_group" {
  project             = var.project_id
  web_backend_service = google_compute_backend_service.seein.name
  role                = "roles/iap.httpsResourceAccessor"
  member              = "group:${var.iap_access_group}"

  depends_on = [google_project_service.required]
}

resource "google_iap_web_cloud_run_service_iam_binding" "gateway_access_group" {
  project                = var.project_id
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.gateway.name
  role                   = "roles/iap.httpsResourceAccessor"
  members                = ["group:${var.iap_access_group}"]

  depends_on = [google_project_service.required]
}

resource "google_compute_url_map" "seein" {
  project         = var.project_id
  name            = "seein-url-map"
  default_service = var.activate_cloud_run_gateway ? google_compute_backend_service.gateway.id : google_compute_backend_service.seein.id
}

resource "google_compute_managed_ssl_certificate" "seein" {
  project = var.project_id
  name    = "seein-managed-cert"

  managed {
    domains = [var.app_domain]
  }
}

resource "google_compute_target_https_proxy" "seein" {
  project          = var.project_id
  name             = "seein-https-proxy"
  url_map          = google_compute_url_map.seein.id
  ssl_certificates = [google_compute_managed_ssl_certificate.seein.id]
}

resource "google_compute_global_address" "seein_load_balancer" {
  project      = var.project_id
  name         = "seein-load-balancer-ip"
  address_type = "EXTERNAL"
  ip_version   = "IPV4"
}

resource "google_compute_global_forwarding_rule" "seein_https" {
  project               = var.project_id
  name                  = "seein-https"
  ip_protocol           = "TCP"
  port_range            = "443"
  load_balancing_scheme = "EXTERNAL"
  target                = google_compute_target_https_proxy.seein.id
  ip_address            = google_compute_global_address.seein_load_balancer.id
}
