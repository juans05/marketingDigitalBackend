# Pineado a Debian 12 "bookworm" (estable). La etiqueta flotante `python:3.11-slim`
# rueda al Debian "testing" más reciente (hoy trixie), donde el instalador de
# dependencias de Playwright (--with-deps) aún no reconoce paquetes renombrados
# (ttf-unifont, ttf-ubuntu-font-family) -> falla el build. bookworm sí es soportado.
FROM python:3.11-slim-bookworm

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
