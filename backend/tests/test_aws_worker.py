import sys
import types

sys.modules.setdefault("boto3", types.SimpleNamespace())

from backend.aws_worker import _update_job


class DummyDdb:
    def __init__(self) -> None:
        self.kwargs = None

    def update_item(self, **kwargs):
        self.kwargs = kwargs


def test_update_job_uses_expression_attribute_names_for_reserved_keywords() -> None:
    ddb = DummyDdb()

    _update_job(
        ddb,
        "jobs-table",
        "job-123",
        status="running",
        current_step="queued",
        completed_steps=["queued"],
        result_key="results/job-123.json",
        error="boom",
    )

    assert ddb.kwargs is not None
    assert ddb.kwargs["ExpressionAttributeNames"]["#status"] == "status"
    assert ddb.kwargs["ExpressionAttributeNames"]["#current_step"] == "current_step"
    assert ddb.kwargs["ExpressionAttributeNames"]["#completed_steps"] == "completed_steps"
    assert ddb.kwargs["ExpressionAttributeNames"]["#updated_at"] == "updated_at"
    assert ddb.kwargs["ExpressionAttributeNames"]["#result_key"] == "result_key"
    assert ddb.kwargs["ExpressionAttributeNames"]["#error"] == "error"
    assert "#status = :status" in ddb.kwargs["UpdateExpression"]
    assert "#error = :error" in ddb.kwargs["UpdateExpression"]
