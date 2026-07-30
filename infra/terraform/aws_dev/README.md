# AWS Dev Terraform

This directory is the single-account dev scaffold for the managed WhisperX service.

Current scope:
- S3 input bucket
- S3 result bucket
- DynamoDB jobs table
- ECR repository for the worker image
- Secrets Manager bearer token
- AWS Batch compute environment / queue / job definition
- Lambda managed API
- HTTP API Gateway

Required inputs:
- private_subnet_ids
- batch_security_group_ids
- lambda_package_path
- managed_service_bearer_token

Supporting files:
- `terraform.tfvars.example`: example variable file for a real dev account
- `scripts/build_lambda_package.ps1`: builds `dist/lambda/backend.zip` at the repository root for the Lambda function

Suggested next commands:
1. Build the Lambda package with `powershell -File scripts/build_lambda_package.ps1`
2. Copy `terraform.tfvars.example` to `terraform.tfvars`
3. Fill in subnet and security group IDs
4. For the first dev rollout, keep Lambda outside the VPC unless NAT or VPC endpoints are prepared
5. Run `terraform init` and `terraform plan`

Notes:
- WAF, alarms, and Budgets are still intentionally out of scope for this first dev scaffold.
- This scaffold assumes an existing VPC and subnets; it does not create the network layer.

## CPU fallback mode

The current `terraform.tfvars.dev-default` uses a temporary CPU Batch path because the dev account has 0 quota for GPU EC2 in `ap-northeast-1`.

Current CPU defaults:
- `batch_instance_types = ["m7i.xlarge"]`
- `batch_gpu_count = 0`
- `whisperx_device = "cpu"`
- `whisperx_compute_type = "int8"`
- `whisperx_batch_size = 1`

The worker image has been validated locally with `device=cpu` and `compute_type=int8` on a small WAV sample. This path is intended to validate AWS Batch, S3, DynamoDB, and result serialization before GPU quota is approved.

GPU quota request docs:
- `docs/aws_gpu_quota_request_for_se_team.md`
- `docs/aws_gpu_quota_request_for_project_members.md`

## Large worker image pull strategy

The WhisperX worker image is intentionally treated as a separate infrastructure risk because the `jim60105/docker-whisperX` based image can be very large.

Operational guidance:
- Use EC2 Batch compute environments rather than Fargate so ECS can reuse local image cache on the same container instance.
- Keep `maxvCpus = 0` when no test is running to avoid cost.
- For focused pull/startup testing, temporarily allow one CPU instance, submit one small job, and monitor Batch/ECS/CloudWatch until the container starts or fails.
- If repeated tests are needed on the same day, consider temporarily keeping one warm instance so the image is not pulled again.
- Add an EC2 launch template before longer tests if image extraction fails or root/Docker storage is suspected to be too small.

Reference docs:
- https://docs.aws.amazon.com/AmazonECS/latest/developerguide/pull-behavior.html
- https://docs.aws.amazon.com/batch/latest/userguide/launch-templates.html

## Transcription language (`whisperx_language`)

`whisperx_language` (default `"ja"`) is passed to the Batch job definition as the `WHISPERX_LANGUAGE`
environment variable (see `main.tf`), which the worker's embedded WhisperX backend reads to pick the
transcription language. It is a deployment-wide setting, not a per-job one: every job submitted through
this Batch job definition transcribes with the same language until the Terraform stack is re-applied
with a different value.

The worker image (`infra/docker/aws_batch_worker/Dockerfile`) is built from
`ghcr.io/jim60105/whisperx:large-v3-ja`, so only the Japanese alignment model is baked into the image.
Whisper itself (`large-v3`) is multilingual, so only the alignment model needs to match the language —
setting `whisperx_language` to anything other than `ja` makes the worker download that language's
alignment model at runtime, which requires outbound network access (HuggingFace / torchaudio) from the
Batch subnet. If the subnet has no outbound path, transcription in a non-`ja` language will fail.

For a permanent switch to another language, rebuild the worker image from the matching base tag (for
example `ghcr.io/jim60105/whisperx:large-v3-en`), push it, and set `whisperx_language` to match — see
[Local WhisperX Setup](../../../docs/wiki/Local-WhisperX-Setup.md) for background on the WhisperX
language/alignment-model relationship.

## Pull debug with SSM

The next pull test should use Session Manager so the Batch EC2 instance can be inspected while the ECS task is still `PENDING`.

Terraform now configures the CPU Batch EC2 path with:
- `AmazonSSMManagedInstanceCore` on the Batch instance role.
- A Batch launch template with a gp3 root volume controlled by `batch_root_volume_size_gb`.
- `ECS_IMAGE_PULL_BEHAVIOR=prefer-cached` in `/etc/ecs/ecs.config`.
- `batch_root_volume_size_gb = 100` in `terraform.tfvars.dev-default` for the next pull test.

During the next pull test, use Session Manager to inspect:
- `df -h`
- `docker images`
- `docker system df`
- `sudo journalctl -u docker --no-pager`
- `sudo tail -f /var/log/ecs/ecs-agent.log`

The previous low-cost pull test used the default 30GB root volume and stayed in ECS `PENDING` for about 19 minutes before being terminated for cost control. That result does not prove disk exhaustion; the next test is intended to distinguish slow pull/unpack from storage pressure.
