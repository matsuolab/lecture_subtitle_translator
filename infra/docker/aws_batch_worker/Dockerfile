FROM ghcr.io/jim60105/whisperx:large-v3-ja

USER root
WORKDIR /app

COPY backend/requirements.txt /app/backend/requirements.txt

RUN python -m ensurepip --upgrade && \
    python -m pip install --no-cache-dir -r /app/backend/requirements.txt

COPY backend /app/backend

ENV PYTHONPATH=/app
ENV WHISPERX_EXECUTION_BACKEND=embedded
ENV WHISPERX_DEVICE=cuda
ENV WHISPERX_MODEL=large-v3
ENV WHISPERX_LANGUAGE=ja
ENV WHISPERX_COMPUTE_TYPE=float16
ENV WHISPERX_BATCH_SIZE=8

ENTRYPOINT []
CMD ["python", "-m", "backend.aws_worker"]

