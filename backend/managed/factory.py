from __future__ import annotations

from dataclasses import dataclass

from ..pipeline.service import PipelineService
from .local_adapter import LocalManagedAdapter
from .settings import ManagedServiceSettings


@dataclass(frozen=True)
class ManagedServices:
    settings: ManagedServiceSettings
    pipeline_service: PipelineService
    adapter: object


def build_managed_services() -> ManagedServices:
    settings = ManagedServiceSettings.from_env()
    pipeline_service = PipelineService()
    if settings.backend_mode == "aws":
        from .aws_adapter import AwsManagedAdapter
        adapter = AwsManagedAdapter(settings)
    else:
        adapter = LocalManagedAdapter(settings, pipeline_service=pipeline_service)
    return ManagedServices(settings=settings, pipeline_service=pipeline_service, adapter=adapter)
