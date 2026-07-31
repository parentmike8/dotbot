# GKE / Agones historical alternative

> Superseded on 2026-07-31 by the production GameLift managed-EC2 path in
> [`../gamelift-ec2/README.md`](../gamelift-ec2/README.md). Do not apply this
> Terraform for production. It is retained only as an archived architecture
> alternative and cost comparison.

This directory records the earlier GKE/Agones design for realtime rooms. It is
intentionally separate from `deploy/deploy.sh`, which ships the web/control
service to Cloud Run.

Nothing in this directory has been applied yet. The Kubernetes Engine API is
still disabled in `dot-bot-c39fc`, so the cluster currently costs $0.

## Safety boundary

Do not run `terraform apply`; this is not an active production plan. A normal
apply would create a regional cluster with six minimum VMs (three game and
three Agones system nodes) in Toronto.

Before applying:

1. install Terraform 1.8+;
2. create a versioned, retention-protected GCS state bucket;
3. copy `terraform/backend.hcl.example` to an ignored local `backend.hcl`;
4. run `terraform init -backend-config=backend.hcl`;
5. run `terraform fmt -check`, `terraform validate`, and
   `terraform plan -out=dotbot-toronto.tfplan`;
6. verify the plan contains only `northamerica-northeast2` resources and six
   minimum nodes;
7. obtain a new explicit product and cost decision before considering any
   captured plan.

The Agones Fleet and autoscaler are added after the game process owns one
allocated session, integrates the Agones SDK, and exposes the WebTransport
sidecar. Applying a generic echo-server Fleet would create paid infrastructure
without advancing the production game and is deliberately excluded.
