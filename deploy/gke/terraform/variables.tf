variable "project_id" {
  description = "Google Cloud project that owns DotBot production."
  type        = string
  default     = "dot-bot-c39fc"
}

variable "region" {
  description = "Primary realtime region."
  type        = string
  default     = "northamerica-northeast2"
}

variable "cluster_name" {
  type    = string
  default = "dotbot-games-toronto"
}

variable "agones_version" {
  type    = string
  default = "1.59.0"
}

variable "game_machine_type" {
  description = "Non-shared-core machines for latency-sensitive game pods."
  type        = string
  default     = "c4-standard-2"
}

variable "system_machine_type" {
  description = "Dedicated machines for Agones controllers and allocator."
  type        = string
  default     = "e2-standard-2"
}

variable "game_nodes_per_zone_min" {
  description = "Regional pools multiply this value across three zones."
  type        = number
  default     = 1
}

variable "game_nodes_per_zone_max" {
  description = "One to four per zone gives a three-to-twelve node game pool."
  type        = number
  default     = 4
}

variable "game_port_range" {
  type    = string
  default = "7000-8000"
}
