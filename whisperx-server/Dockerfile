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

# pip はベースイメージで削除されているため ensurepip で復活させる
# その後 FastAPI 関連パッケージのみ追加インストール
RUN python -m ensurepip --upgrade && \
    pip install --no-cache-dir \
        fastapi==0.115.0 \
        uvicorn[standard]==0.30.6 \
        python-multipart==0.0.9

COPY server.py /app/server.py

EXPOSE 8000

# CLI の ENTRYPOINT を上書きして FastAPI サーバーとして起動
ENTRYPOINT ["python", "-m", "uvicorn", "server:app", \
            "--host", "0.0.0.0", "--port", "8000", "--timeout-keep-alive", "300"]
