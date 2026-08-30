variable "project_id" {
  description = "Google Cloud project that owns the SeeIn deployment."
  type        = string
  default     = "seein-507115"
}

variable "region" {
  description = "Region for registry, IP address, and VM network resources."
  type        = string
  default     = "asia-south1"
}

variable "zone" {
  description = "Compute Engine zone for the SeeIn VM."
  type        = string
  default     = "asia-south1-a"
}

variable "machine_type" {
  description = "Initial VM size. Increase to e2-standard-4 if Chromium and ClickHouse need more headroom."
  type        = string
  default     = "e2-standard-2"
}

variable "boot_disk_size_gb" {
  description = "Persistent SSD boot-disk capacity, including Docker and application data."
  type        = number
  default     = 100
}

variable "app_port" {
  description = "Internal SeeIn HTTP port. No public firewall rule is created for this port."
  type        = number
  default     = 8787
}

variable "app_domain" {
  description = "Hostname served by the IAP-protected HTTPS load balancer."
  type        = string
  default     = "seein.maybecoded.com"
}

variable "enable_iap_backend_ingress" {
  description = "Set only after IAP is enabled with a custom OAuth client in the Google Cloud console."
  type        = bool
  default     = false
}

variable "iap_access_group" {
  description = "Google Group permitted to access the IAP-protected SeeIn frontend."
  type        = string
  default     = "seein-access@googlegroups.com"
}
