# WhisperX HTTP サーバー
#
# jim60105/docker-whisperX の large-v3-ja タグをベースに使う。
# モデル・CUDA・WhisperX 依存関係はすべてベースイメージに含まれている。
# ENTRYPOINT だけ CLI → FastAPI サーバーに差し替える。
#
# ビルド:
#   docker compose build
#
# 注意: large-v3-ja タグは ~10GB。初回 pull に時間がかかる。

FROM ghcr.io/jim60105/whisperx:large-v3-ja

USER root

ARG WHISPERX_SERVER_VERSION=dev
ENV WHISPERX_SERVER_VERSION=${WHISPERX_SERVER_VERSION}

# pip はベースイメージで PATH 上に見えないため ensurepip で復活させ、
# CLI 名ではなく `python -m pip` で FastAPI 関連だけ追加する
RUN python -m ensurepip --upgrade && \
    python -m pip install --no-cache-dir \
        fastapi==0.115.0 \
        uvicorn[standard]==0.30.6 \
        python-multipart==0.0.9

COPY server.py /app/server.py

EXPOSE 8000

# CLI の ENTRYPOINT を上書きして FastAPI サーバーとして起動
ENTRYPOINT ["python", "-m", "uvicorn", "server:app", \
            "--host", "0.0.0.0", "--port", "8000", "--timeout-keep-alive", "300"]
