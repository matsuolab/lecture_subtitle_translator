variable "project_name" {
  type    = string
  default = "matsuo-subtitle-pipeline"
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "aws_region" {
  type    = string
  default = "ap-northeast-1"
}

variable "managed_service_bearer_token" {
  type      = string
  sensitive = true
}

variable "batch_instance_types" {
  type    = list(string)
  default = ["g4dn.xlarge"]
}

variable "batch_ec2_image_type" {
  type    = string
  default = "ECS_AL2023_NVIDIA"
}

variable "batch_ondemand_max_vcpus" {
  type    = number
  default = 4
}

variable "batch_gpu_spot_max_vcpus" {
  type    = number
  default = 4
}

variable "batch_gpu_ondemand_max_vcpus" {
  type    = number
  default = 4
}

variable "batch_vcpus" {
  type    = number
  default = 2
}

variable "batch_memory" {
  type    = number
  default = 12288
}

variable "batch_gpu_count" {
  type    = number
  default = 1
}

variable "batch_root_volume_size_gb" {
  type    = number
  default = 100
}

variable "batch_custom_ami_id" {
  type    = string
  default = ""
}

variable "batch_worker_image_reference" {
  type    = string
  default = ""
}

variable "batch_image_pull_behavior" {
  type    = string
  default = "prefer-cached"
}

variable "whisperx_device" {
  type    = string
  default = "cuda"
}

variable "whisperx_model" {
  type    = string
  default = "large-v3"
}

variable "whisperx_language" {
  type    = string
  default = "ja"
}

variable "whisperx_compute_type" {
  type    = string
  default = "float16"
}

variable "whisperx_batch_size" {
  type    = number
  default = 4
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "batch_security_group_ids" {
  type = list(string)
}

variable "lambda_subnet_ids" {
  type    = list(string)
  default = []
}

variable "lambda_security_group_ids" {
  type    = list(string)
  default = []
}

variable "lambda_package_path" {
  type    = string
  default = "../../../dist/lambda/backend.zip"
}

variable "batch_include_cpu_fallback" {
  type    = bool
  default = false
}

