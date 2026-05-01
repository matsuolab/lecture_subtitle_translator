output "service_url" {
  value = aws_apigatewayv2_stage.managed.invoke_url
}

output "input_bucket_name" {
  value = aws_s3_bucket.input.bucket
}

output "result_bucket_name" {
  value = aws_s3_bucket.result.bucket
}

output "jobs_table_name" {
  value = aws_dynamodb_table.jobs.name
}

output "batch_job_queue" {
  value = aws_batch_job_queue.queue.name
}

output "batch_job_definition" {
  value = aws_batch_job_definition.worker.name
}

output "lambda_function_name" {
  value = aws_lambda_function.managed_api.function_name
}
