FROM python:3.11-slim

# Instalar FFmpeg, curl y dependencias básicas
RUN apt-get update && \
    apt-get install -y ffmpeg curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Instalar navegador Chromium de Playwright y dependencias requeridas en Debian/Ubuntu
RUN playwright install chromium --with-deps

COPY . .

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
