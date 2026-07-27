terraform {
  required_version = ">= 1.8.0"

  # Supply bucket and prefix during init. Production state must never live on
  # a developer machine: terraform init -backend-config=backend.hcl
  backend "gcs" {}

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.17"
    }
  }
}
