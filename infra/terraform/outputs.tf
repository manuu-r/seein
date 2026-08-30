output "artifact_registry_image" {
  description = "Repository path for the SeeIn core image."
  value       = local.registry_path
}

output "cloud_run_gateway" {
  description = "Cloud Run gateway behind the IAP-protected load balancer."
  value       = google_cloud_run_v2_service.gateway.name
}

output "vm_name" {
  value = google_compute_instance.seein.name
}

output "vm_zone" {
  value = google_compute_instance.seein.zone
}

output "vm_static_ip" {
  description = "Reserved VM address. It is not yet open to HTTP traffic."
  value       = google_compute_address.seein.address
}

output "load_balancer_ip" {
  description = "Create an A record for seein.maybecoded.com that points to this address."
  value       = google_compute_global_address.seein_load_balancer.address
}

output "iap_console_url" {
  description = "After DNS is set, use this page to configure External OAuth and let IAP generate credentials."
  value       = "https://console.cloud.google.com/security/iap?project=${var.project_id}"
}

output "iap_tunnel_command" {
  description = "Use this to reach the private pilot over a local browser tunnel after deployment."
  value       = "gcloud compute ssh ${google_compute_instance.seein.name} --project=${var.project_id} --zone=${var.zone} --tunnel-through-iap -- -L ${var.app_port}:localhost:${var.app_port}"
}
