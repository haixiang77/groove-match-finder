# RefScope Python server + web UI (for cloud hosting: Render, Fly.io, Cloud Run, HF Spaces …)
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml README.md ./
COPY refscope ./refscope
RUN pip install --no-cache-dir .
COPY index.html manifest.webmanifest ./
COPY assets ./assets
COPY src ./src
ENV REFSCOPE_WEB_DIR=/app PORT=8000 PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["sh", "-c", "refscope serve --host 0.0.0.0 --port ${PORT} --no-qr"]
