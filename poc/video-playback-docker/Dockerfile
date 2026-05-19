FROM mcr.microsoft.com/playwright:v1.56.1-noble

WORKDIR /probe

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY scripts ./scripts

ENV RUN_BROWSER=1

CMD ["node", "scripts/run-tests.mjs"]
