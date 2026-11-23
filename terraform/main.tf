# Change 091/092 — GitHub Actions release secrets, codified.
# Public repo: secret VALUES come from terraform vars (never committed).
# Apply: terraform apply -var github_token=$(gh auth token) -var token_value=$(<secret source>)
# State (contains sensitive values) is gitignored.

terraform {
  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}

variable "github_token" {
  type      = string
  sensitive = true
}

variable "token_value" {
  type      = string
  sensitive = true
}

provider "github" {
  owner = "trysolti"
  token = var.github_token
}

data "github_repository" "this" {
  name = "solti-sdk-ts"
}

resource "github_actions_secret" "NPM_TOKEN" {
  repository      = data.github_repository.this.name
  secret_name     = "NPM_TOKEN"
  plaintext_value = var.token_value
}
