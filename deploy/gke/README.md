# Dedicated realtime deployment

This directory is the production GKE/Agones replacement for realtime rooms.
It is intentionally separate from `deploy/deploy.sh`, which continues to ship
the web/control-plane service to Cloud Run during migration.

Nothing in this directory has been applied yet. The Kubernetes Engine API is
still disabled in `dot-bot-c39fc`, so the cluster currently costs $0.

## Safety boundary

Do not run `terraform apply` until the monthly floor in
`docs/production-realtime-architecture.md` is approved. A normal apply creates
a regional cluster with six minimum VMs (three game and three Agones system
nodes) in Toronto.

Before applying:

1. install Terraform 1.8+;
2. create a versioned, retention-protected GCS state bucket;
3. copy `terraform/backend.hcl.example` to an ignored local `backend.hcl`;
4. run `terraform init -backend-config=backend.hcl`;
5. run `terraform fmt -check`, `terraform validate`, and
   `terraform plan -out=dotbot-toronto.tfplan`;
6. verify the plan contains only `northamerica-northeast2` resources and six
   minimum nodes;
7. obtain explicit approval for the captured plan, then apply that plan file.

The Agones Fleet and autoscaler are added after the game process owns one
allocated session, integrates the Agones SDK, and exposes the WebTransport
sidecar. Applying a generic echo-server Fleet would create paid infrastructure
without advancing the production game and is deliberately excluded.
