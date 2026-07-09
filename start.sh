#!/bin/bash
# Start Python unified services in background
echo "⚡ Starting Vidalis Python Services..."
cd /app/python-services
export PORT=8080
/app/venv/bin/python main.py &
PYTHON_SERVICES_PID=$!
cd /app

# Wait for services to be ready
sleep 3

# Start Node backend
echo "🚀 Starting Vidalis Backend (Node)..."
export SCRAPER_URL=http://localhost:8080
export CLIPPER_SERVICE_URL=http://localhost:8080
node src/app.js
