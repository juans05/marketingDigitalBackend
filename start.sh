#!/bin/bash
# Start Python scraper in background
echo "🕵️ Starting Vidalis Scraper (Python)..."
cd /app/scraper
/app/venv/bin/python server.py &
SCRAPER_PID=$!
cd /app

# Wait for scraper to be ready
sleep 3

# Start Node backend
echo "🚀 Starting Vidalis Backend (Node)..."
export SCRAPER_URL=http://localhost:3002
node src/app.js
