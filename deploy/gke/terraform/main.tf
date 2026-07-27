provider "google" {
  project = var.project_id
  region  = var.region
}

data "google_client_config" "current" {}

resource "google_project_service" "container" {
  project            = var.project_id
  service            = "container.googleapis.com"
  disable_on_destroy = false
}

resource "google_compute_network" "games" {
  project                 = var.project_id
  name                    = "dotbot-games"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "games" {
  project       = var.project_id
  name          = "dotbot-games-toronto"
  region        = var.region
  network       = google_compute_network.games.id
  ip_cidr_range = "10.40.0.0/20"

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.44.0.0/14"
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.48.0.0/20"
  }
}

resource "google_compute_firewall" "game_ports" {
  project = var.project_id
  name    = "dotbot-game-ports"
  network = google_compute_network.games.name

  allow {
    protocol = "udp"
    ports    = [var.game_port_range]
  }

  # Reserved for the compatibility transport and controlled migrations.
  allow {
    protocol = "tcp"
    ports    = [var.game_port_range]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["dotbot-game-server"]
}

resource "google_container_cluster" "games" {
  project  = var.project_id
  name     = var.cluster_name
  location = var.region

  network    = google_compute_network.games.id
  subnetwork = google_compute_subnetwork.games.id

  deletion_protection      = true
  remove_default_node_pool = true
  initial_node_count       = 1
  networking_mode          = "VPC_NATIVE"

  release_channel {
    channel = "REGULAR"
  }

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  logging_config {
    enable_components = ["SYSTEM_COMPONENTS", "WORKLOADS"]
  }

  monitoring_config {
    enable_components = ["SYSTEM_COMPONENTS"]
    managed_prometheus {
      enabled = true
    }
  }

  maintenance_policy {
    recurring_window {
      start_time = "2026-01-01T08:00:00Z"
      end_time   = "2026-01-01T12:00:00Z"
      recurrence = "FREQ=WEEKLY;BYDAY=TU,WE,TH"
    }
  }

  depends_on = [google_project_service.container]
}

resource "google_container_node_pool" "agones_system" {
  project  = var.project_id
  name     = "agones-system"
  cluster  = google_container_cluster.games.id
  location = var.region

  # In a regional cluster this is one node in each of three zones.
  node_count = 1

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  node_config {
    machine_type = var.system_machine_type
    disk_type    = "pd-balanced"
    disk_size_gb = 30
    image_type   = "COS_CONTAINERD"

    labels = {
      "agones.dev/agones-system" = "true"
      "dotbot.dev/role"          = "agones-system"
    }

    taint {
      key    = "agones.dev/agones-system"
      value  = "true"
      effect = "NO_EXECUTE"
    }

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }

    oauth_scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }
}

resource "google_container_node_pool" "game_servers" {
  project  = var.project_id
  name     = "game-servers"
  cluster  = google_container_cluster.games.id
  location = var.region

  autoscaling {
    min_node_count  = var.game_nodes_per_zone_min
    max_node_count  = var.game_nodes_per_zone_max
    location_policy = "BALANCED"
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  upgrade_settings {
    strategy        = "SURGE"
    max_surge       = 1
    max_unavailable = 0
  }

  node_config {
    machine_type = var.game_machine_type
    disk_type    = "pd-balanced"
    disk_size_gb = 30
    image_type   = "COS_CONTAINERD"
    tags         = ["dotbot-game-server"]

    labels = {
      "dotbot.dev/role" = "game-server"
    }

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }

    oauth_scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }
}

provider "helm" {
  kubernetes {
    host                   = "https://${google_container_cluster.games.endpoint}"
    token                  = data.google_client_config.current.access_token
    cluster_ca_certificate = base64decode(google_container_cluster.games.master_auth[0].cluster_ca_certificate)
  }
}

resource "helm_release" "agones" {
  name             = "agones"
  repository       = "https://agones.dev/chart/stable"
  chart            = "agones"
  version          = var.agones_version
  namespace        = "agones-system"
  create_namespace = true
  atomic           = true
  timeout          = 900

  set {
    name  = "agones.requireDedicatedNodes"
    value = "true"
  }

  set {
    name  = "gameservers.minPort"
    value = split("-", var.game_port_range)[0]
  }

  set {
    name  = "gameservers.maxPort"
    value = split("-", var.game_port_range)[1]
  }

  set {
    name  = "gameservers.namespaces[0]"
    value = "dotbot-games"
  }

  depends_on = [
    google_container_node_pool.agones_system,
    google_container_node_pool.game_servers,
  ]
}
