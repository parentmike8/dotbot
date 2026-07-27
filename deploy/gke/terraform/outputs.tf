output "cluster_name" {
  value = google_container_cluster.games.name
}

output "cluster_region" {
  value = google_container_cluster.games.location
}

output "get_credentials_command" {
  value = "gcloud container clusters get-credentials ${google_container_cluster.games.name} --region ${var.region} --project ${var.project_id}"
}
