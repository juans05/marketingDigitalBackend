"""
Vidalis Python Services
Consolidated FastAPI microservice that handles both:
1. AI Scraper (Spy Mode) using ScrapeGraph-AI and Playwright.
2. Video Clipper (Repurposer) using FFmpeg and Cloudinary.
"""

import os
import json
import re
import asyncio
import subprocess
import shutil
import requests
from urllib.parse import urlparse
from concurrent.futures import ThreadPoolExecutor
from typing import Optional, List
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import cloudinary
import cloudinary.uploader

# Cargar variables de entorno del archivo .env
load_dotenv()

app = FastAPI(title="Vidalis Python Services", version="2.0.0")

# Habilitar CORS para permitir cargas y solicitudes directas del frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configurar Cloudinary con variables de entorno
cloudinary.config(
    cloud_name=os.getenv("CLOUDINARY_CLOUD_NAME"),
    api_key=os.getenv("CLOUDINARY_API_KEY"),
    api_secret=os.getenv("CLOUDINARY_API_SECRET"),
    secure=True
)


_executor = ThreadPoolExecutor(max_workers=4)


# ── Lógica y Helpers del Scraper ──────────────────────────────────────────────

def _clean_result(result):
    """Normalize LLM output: replace bare NA/None/null with null, unwrap 'content' wrapper."""
    if isinstance(result, dict):
        if list(result.keys()) == ["content"] and isinstance(result["content"], dict):
            result = result["content"]
        return {k: (None if v in ("NA", "N/A", "None", "none", "null", "undefined") else v)
                for k, v in result.items()}
    if isinstance(result, str):
        cleaned = re.sub(r'(?<!["\w])NA(?!["\w])', 'null', result)
        try:
            return _clean_result(json.loads(cleaned))
        except json.JSONDecodeError:
            return {"raw": result}
    return result

def get_graph_config():
    """Build ScrapeGraph config from env vars. Default: Groq (free)."""
    api_key = os.getenv("GROQ_API_KEY") or os.getenv("SCRAPER_LLM_KEY")
    model = os.getenv("SCRAPER_LLM_MODEL", "groq/llama-3.3-70b-versatile")

    if not api_key and "ollama" not in model.lower():
        raise ValueError("Set GROQ_API_KEY or SCRAPER_LLM_KEY env var")

    config = {
        "llm": {
            "model": model,
            "api_key": api_key or "not-needed",
            "temperature": 0,
        },
        "verbose": False,
        "headless": True,
    }
    return config

RULES = """
IMPORTANT RULES for the JSON output:
- All number fields must be integers (e.g. 368500), never strings or "NA"
- If a value is not found, use null for strings and 0 for numbers
- Never use NA, N/A, "NA", None, or undefined — use null or 0
- Return ONLY the raw JSON object, no markdown, no code blocks, no extra text
"""

TIKTOK_PROMPT = """Extract from this TikTok profile page:
- username (string)
- display_name (string)
- followers count (integer, e.g. 368500 for "368.5K")
- following count (integer)
- total likes/hearts count (integer)
- total videos count (integer)
- bio/description (string)
- is_verified (boolean)
Return as JSON object with these exact keys: username, display_name, followers, following, likes, videos, bio, is_verified
""" + RULES

INSTAGRAM_PROMPT = """Extract from this Instagram profile page:
- username (string)
- display_name / full name (string)
- followers count (integer)
- following count (integer)
- total posts count (integer)
- bio/description (string)
- is_verified (boolean)
- profile_picture_url (string)
Return as JSON object with these exact keys: username, display_name, followers, following, posts, bio, is_verified, profile_picture_url
""" + RULES

YOUTUBE_PROMPT = """Extract from this YouTube channel page:
- channel_name (string)
- subscribers count (integer, parse "K" as thousands, "M" as millions, e.g. "1.2M" = 1200000)
- total videos count (integer)
- description/about (string, first 200 chars)
- is_verified (boolean)
- profile_picture_url (string)
Return as JSON object with these exact keys: channel_name, subscribers, videos, description, is_verified, profile_picture_url
""" + RULES

FACEBOOK_PROMPT = """Extract from this Facebook page:
- page_name (string)
- followers count (integer)
- likes count (integer)
- category (string)
- description (string, first 200 chars)
Return as JSON object with these exact keys: page_name, followers, likes, category, description
""" + RULES

PLATFORM_CONFIG = {
    "tiktok": {
        "url_template": "https://www.tiktok.com/@{username}",
        "prompt": TIKTOK_PROMPT,
    },
    "instagram": {
        "url_template": "https://www.instagram.com/{username}/",
        "prompt": INSTAGRAM_PROMPT,
    },
    "youtube": {
        "url_template": "https://www.youtube.com/@{username}",
        "prompt": YOUTUBE_PROMPT,
    },
    "facebook": {
        "url_template": "https://www.facebook.com/{username}",
        "prompt": FACEBOOK_PROMPT,
    },
}


# ── Modelos Pydantic ──────────────────────────────────────────────────────────

class ScrapeRequest(BaseModel):
    platform: str
    username: str

class MultiScrapeRequest(BaseModel):
    tiktok_username: Optional[str] = None
    youtube_username: Optional[str] = None
    instagram_username: Optional[str] = None
    facebook_username: Optional[str] = None

class Segment(BaseModel):
    start: float
    end: float
    title: str

class CutRequest(BaseModel):
    source_url: str
    segments: List[Segment]
    artist_id: str


def validate_source_url(source_url):
    """Bloquea SSRF / lectura de archivos: solo http(s) y, si R2_PUBLIC_URL está
    configurado, solo el host de R2 (los fuentes siempre son URLs que nosotros
    producimos en R2)."""
    parsed = urlparse(source_url or "")
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="source_url debe ser http(s)")
    allowed_host = urlparse(os.getenv("R2_PUBLIC_URL", "")).hostname
    if allowed_host and parsed.hostname != allowed_host:
        raise HTTPException(status_code=400, detail="source_url no proviene de un origen permitido")
    return source_url


def build_ffmpeg_cut_command(source_url, start, end, output_path):
    return [
        "ffmpeg", "-y",
        "-ss", str(start),
        "-to", str(end),
        "-i", source_url,
        "-c", "copy",
        output_path,
    ]


# ── Helpers del Clipper ────────────────────────────────────────────────────────

def cleanup_files(paths: List[str]):
    for path in paths:
        if os.path.exists(path):
            try:
                os.remove(path)
                print(f"Archivo temporal eliminado: {path}")
            except Exception as e:
                print(f"Error borrando archivo temporal {path}: {e}")


# ── Endpoints Unificados ───────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "vidalis-python-services",
        "scraper": "ready",
        "clipper": "ready"
    }


# ── Endpoints: Scraper AI ─────────────────────────────────────────────────────

@app.post("/scrape")
async def scrape_profile(req: ScrapeRequest):
    """Scrape a single platform profile."""
    platform = req.platform.lower()
    username = req.username.replace("@", "").strip()

    if platform not in PLATFORM_CONFIG:
        raise HTTPException(400, f"Platform '{platform}' not supported. Use: {list(PLATFORM_CONFIG.keys())}")

    if not username:
        raise HTTPException(400, "Username is required")

    config = PLATFORM_CONFIG[platform]
    url = config["url_template"].format(username=username)
    prompt = config["prompt"]

    try:
        from scrapegraphai.graphs import SmartScraperGraph

        def _run():
            graph_config = get_graph_config()
            scraper = SmartScraperGraph(prompt=prompt, source=url, config=graph_config)
            return scraper.run()

        result = await asyncio.get_event_loop().run_in_executor(_executor, _run)
        result = _clean_result(result)

        return {
            "platform": platform,
            "username": username,
            "url": url,
            "data": result,
            "source": "scrapegraph-ai",
        }

    except Exception as e:
        raise HTTPException(500, f"Scrape failed for @{username} on {platform}: {str(e)}")


@app.post("/scrape-all")
async def scrape_all_platforms(req: MultiScrapeRequest):
    """Scrape all provided platform usernames in one call."""
    results = {}
    errors = {}

    platforms_to_scrape = []
    if req.tiktok_username:
        platforms_to_scrape.append(("tiktok", req.tiktok_username))
    if req.youtube_username:
        platforms_to_scrape.append(("youtube", req.youtube_username))
    if req.instagram_username:
        platforms_to_scrape.append(("instagram", req.instagram_username))
    if req.facebook_username:
        platforms_to_scrape.append(("facebook", req.facebook_username))

    if not platforms_to_scrape:
        raise HTTPException(400, "At least one username is required")

    from scrapegraphai.graphs import SmartScraperGraph

    for platform, username in platforms_to_scrape:
        username = username.replace("@", "").strip()
        if not username:
            continue

        config = PLATFORM_CONFIG[platform]
        url = config["url_template"].format(username=username)

        try:
            def _run():
                graph_config = get_graph_config()
                scraper = SmartScraperGraph(prompt=config["prompt"], source=url, config=graph_config)
                return scraper.run()

            result = await asyncio.get_event_loop().run_in_executor(_executor, _run)
            result = _clean_result(result)

            # Normalize numbers that might come as strings
            for key in ["followers", "following", "likes", "videos", "posts", "subscribers"]:
                if key in result and isinstance(result[key], str):
                    cleaned = result[key].replace(",", "").replace(".", "").strip()
                    multipliers = {"K": 1000, "M": 1000000, "B": 1000000000}
                    for suffix, mult in multipliers.items():
                        if cleaned.upper().endswith(suffix):
                            try:
                                result[key] = int(float(cleaned[:-1]) * mult)
                            except ValueError:
                                pass
                            break
                    else:
                        try:
                            result[key] = int(cleaned)
                        except ValueError:
                            pass

            results[platform] = {
                "username": username,
                "url": url,
                "data": result,
                "source": "scrapegraph-ai",
            }

        except Exception as e:
            errors[platform] = str(e)

    return {
        "results": results,
        "errors": errors,
        "platforms_scraped": list(results.keys()),
        "platforms_failed": list(errors.keys()),
    }


# ── Endpoints: Clipper de Video ────────────────────────────────────────────────

@app.post("/cut")
def cut_video(payload: CutRequest, background_tasks: BackgroundTasks):
    validate_source_url(payload.source_url)
    import tempfile
    temp_dir = tempfile.mkdtemp(prefix="repurpose_")
    files_to_clean = []
    results = []

    for idx, segment in enumerate(payload.segments):
        output_path = os.path.join(temp_dir, f"clip_{idx}.mp4")
        files_to_clean.append(output_path)
        command = build_ffmpeg_cut_command(payload.source_url, segment.start, segment.end, output_path)

        try:
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            upload_result = cloudinary.uploader.upload(
                output_path,
                resource_type="video",
                folder=f"vidalis/{payload.artist_id}/clips"
            )

            results.append({
                "title": segment.title,
                "start": segment.start,
                "end": segment.end,
                "secure_url": upload_result.get("secure_url"),
                "duration": upload_result.get("duration")
            })
        except Exception as e:
            results.append({
                "title": segment.title,
                "start": segment.start,
                "end": segment.end,
                "status": "failed",
                "error": str(e)
            })

    background_tasks.add_task(cleanup_files, files_to_clean)
    background_tasks.add_task(shutil.rmtree, temp_dir, ignore_errors=True)

    return {"clips": results}


# ── Run ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    # El puerto por defecto se unifica a 8080 en producción / local
    port = int(os.getenv("PORT", "8080"))
    print(f"🚀 Vidalis Python Services unificado iniciando en el puerto {port}...")
    uvicorn.run(app, host="0.0.0.0", port=port)
