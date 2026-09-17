# syntax=docker/dockerfile:1
FROM python:3.12-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
COPY server/requirements.txt /requirements.txt
RUN python -m pip install --no-cache-dir --prefix=/install -r /requirements.txt

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TDS_DIRECTORY=/app/tds \
    DATA_SOURCE=wot

RUN useradd --create-home --uid 10001 appuser
COPY --from=builder /install /usr/local
WORKDIR /app
COPY server/app /app/app
COPY tds /app/tds
USER appuser

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)"]
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]