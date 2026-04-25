import importlib
import os
import sys
import time
import types
from unittest.mock import Mock
from unittest.mock import patch

from fastapi.testclient import TestClient


def _load_app_with_env(env: dict[str, str]):
    original = {key: os.environ.get(key) for key in env}
    try:
        os.environ.update(env)
        import backend.api as backend_api
        backend_api = importlib.reload(backend_api)
        return backend_api.app
    finally:
        for key, value in original.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _wait_for_job(client: TestClient, job_id: str, timeout: float = 15.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        response = client.get(f"/v1/jobs/{job_id}")
        assert response.status_code == 200
        payload = response.json()
        if payload["status"] in ("success", "failed", "cancelled"):
            return payload
        time.sleep(0.05)
    raise TimeoutError(f"job {job_id} did not finish within {timeout}s")


def test_service_config_endpoint() -> None:
    app = _load_app_with_env({"MANAGED_SERVICE_BACKEND": "local", "MANAGED_SERVICE_AUTH_MODE": "none"})
    client = TestClient(app)
    response = client.get("/v1/service-config")
    assert response.status_code == 200
    payload = response.json()
    assert payload["service"] == "subtitle-managed-service"
    assert payload["upload"]["strategy"] == "local-put"
    assert payload["auth"]["mode"] in ("none", "bearer_token")


def test_managed_upload_and_job_flow() -> None:
    app = _load_app_with_env({"MANAGED_SERVICE_BACKEND": "local", "MANAGED_SERVICE_AUTH_MODE": "none"})
    client = TestClient(app)
    upload_response = client.post("/v1/uploads", json={"filename": "lecture.wav"})
    assert upload_response.status_code == 200
    upload_payload = upload_response.json()
    assert upload_payload["upload_method"] == "PUT"
    assert upload_payload["object_key"]

    put_response = client.put(
        upload_payload["upload_url"],
        content=b"stub wav bytes",
        headers={"Content-Type": "audio/wav"},
    )
    assert put_response.status_code == 200

    start_response = client.post(
        "/v1/jobs",
        json={
            "source_name": "lecture.wav",
            "input_key": upload_payload["object_key"],
            "execution_mode": "dev",
            "runtime_settings": {},
        },
    )
    assert start_response.status_code == 200
    start_payload = start_response.json()
    assert start_payload["job_id"]

    status_payload = _wait_for_job(client, start_payload["job_id"])
    assert status_payload["status"] == "success"

    result_response = client.get(f"/v1/jobs/{start_payload['job_id']}/result")
    assert result_response.status_code == 200
    result_payload = result_response.json()
    assert isinstance(result_payload["translated_segments"], list)
    assert "audit" in result_payload


def test_managed_job_rejects_missing_upload() -> None:
    app = _load_app_with_env({"MANAGED_SERVICE_BACKEND": "local", "MANAGED_SERVICE_AUTH_MODE": "none"})
    client = TestClient(app)
    response = client.post(
        "/v1/jobs",
        json={
            "source_name": "lecture.wav",
            "input_key": "missing-upload-id",
            "execution_mode": "dev",
        },
    )
    assert response.status_code == 404


def test_bearer_token_required_when_enabled() -> None:
    app = _load_app_with_env(
        {
            "MANAGED_SERVICE_BACKEND": "local",
            "MANAGED_SERVICE_AUTH_MODE": "bearer_token",
            "MANAGED_SERVICE_BEARER_TOKEN": "test-token",
        }
    )
    client = TestClient(app)

    unauthorized = client.post("/v1/uploads", json={"filename": "lecture.wav"})
    assert unauthorized.status_code == 401

    authorized = client.post(
        "/v1/uploads",
        json={"filename": "lecture.wav"},
        headers={"Authorization": "Bearer test-token"},
    )
    assert authorized.status_code == 200


def test_bearer_token_can_be_loaded_from_secrets_manager() -> None:
    secrets_client = Mock()
    secrets_client.get_secret_value.return_value = {"SecretString": "secret-token"}
    session = Mock()
    session.client.return_value = secrets_client
    fake_boto3 = types.SimpleNamespace(session=types.SimpleNamespace(Session=Mock(return_value=session)))

    with patch.dict(sys.modules, {"boto3": fake_boto3}):
        app = _load_app_with_env(
            {
                "MANAGED_SERVICE_BACKEND": "local",
                "MANAGED_SERVICE_AUTH_MODE": "bearer_token",
                "MANAGED_SERVICE_BEARER_TOKEN_SECRET_NAME": "managed-service-token",
                "AWS_REGION": "ap-northeast-1",
            }
        )
        client = TestClient(app)

        authorized = client.post(
            "/v1/uploads",
            json={"filename": "lecture.wav"},
            headers={"Authorization": "Bearer secret-token"},
        )
        assert authorized.status_code == 200
        secrets_client.get_secret_value.assert_called_once_with(SecretId="managed-service-token")
