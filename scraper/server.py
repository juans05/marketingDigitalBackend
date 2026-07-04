"""
Vidalis Spy Mode — ScrapeGraph-AI Microservice
Lightweight FastAPI server that scrapes social media profiles using AI.
Node.js backend calls this via HTTP.
"""

import os
import json
import re
import asyncio
from concurrent.futures import ThreadPoolExecutor
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional


def _clean_result(result):
    """Normalize LLM output: replace bare NA/None/null with null, unwrap 'content' wrapper."""
    if isinstance(result, dict):
        # Unwrap {"content": {...}} wrapper that ScrapeGraph sometimes returns
        if list(result.keys()) == ["content"] and isinstance(result["content"], dict):
            result = result["content"]
        return {k: (None if v in ("NA", "N/A", "None", "none", "null", "undefined") else v)
                for k, v in result.items()}
    if isinstance(result, str):
        # Replace unquoted NA values before JSON parsing
        cleaned = re.sub(r'(?<!["\w])NA(?!["\w])', 'null', result)
        try:
            return _clean_result(json.loads(cleaned))
        except json.JSONDecodeError:
            return {"raw": result}
    return result

_executor = ThreadPoolExecutor(max_workers=4)

load_dotenv()

app = FastAPI(title="Vidalis Scraper", version="1.0.0")

# ── Config ────────────────────────────────────────────────────────────────────

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


# ── Prompts per platform ──────────────────────────────────────────────────────

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


# ── Request/Response models ───────────────────────────────────────────────────

class ScrapeRequest(BaseModel):
    platform: str
    username: str

class MultiScrapeRequest(BaseModel):
    tiktok_username: Optional[str] = None
    youtube_username: Optional[str] = None
    instagram_username: Optional[str] = None
    facebook_username: Optional[str] = None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "service": "vidalis-scraper"}


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


# ── Run ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("SCRAPER_PORT", "3002"))
    print(f"🕵️ Vidalis Scraper starting on port {port}...")
    uvicorn.run(app, host="0.0.0.0", port=port)
