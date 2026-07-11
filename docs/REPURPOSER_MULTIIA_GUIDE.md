# Repurposer Multi-IA Pipeline Guide

## Overview

The Repurposer Multi-IA Pipeline is a high-performance video processing system that transforms long-form videos (2+ hours) into short, viral-optimized clips. It orchestrates five specialized services working in sequence:

1. **Transcribing** — Extract audio and convert speech to text (Grok API with Whisper fallback)
2. **Analyzing** — Detect narrative moments and hooks (Claude Opus 4.6)
3. **Generating** — Cut video clips from moments (ffmpeg with stream copying)
4. **Validating** — Analyze clip frames for visual appeal (Gemini 2.5 Vision)
5. **Scoring** — Calculate viral potential (Vidalis AI scoring engine)

**Result:** Ordered list of clips with viral scores, validation results, and platform recommendations.

## Architecture

```
Input Video (2h+)
  ↓
┌─────────────────────────────────────────────────────┐
│ Repurposer Multi-IA Pipeline                        │
├─────────────────────────────────────────────────────┤
│                                                     │
│  1. Transcription Service                          │
│     • ffmpeg extracts audio (.wav)                 │
│     • Grok API or local Whisper transcribes        │
│     → Updates DB: stage='transcribing'             │
│                                                     │
│  2. Moment Detection Service                       │
│     • Claude analyzes transcript (~30s)            │
│     • Extracts 3-8 narrative hooks                 │
│     → Updates DB: stage='analyzing'                │
│                                                     │
│  3. Clip Generation Service                        │
│     • ffmpeg cuts clips from moments               │
│     • Uses stream copy (-c:v copy -c:a copy)       │
│     → Updates DB: stage='generating' + progress    │
│                                                     │
│  4. Clip Validation Service                        │
│     • Extracts 3 keyframes per clip                │
│     • Gemini Vision analyzes visual hooks          │
│     → Updates DB: stage='validating' + progress    │
│                                                     │
│  5. Clip Scoring Service                           │
│     • Vidalis scores each clip                     │
│     • Calculates platform recommendations          │
│     → Updates DB: stage='scoring' + progress       │
│                                                     │
└─────────────────────────────────────────────────────┘
  ↓
Output: Clips + Scores + Validation + Recommendations
  ↓
Frontend: Real-time progress display (1.5s polling)
```

## Data Flow

### Database Updates (ai_clips_data)

The system updates a JSONB column `ai_clips_data` in the `videos` table at each stage:

```javascript
// Stage transitions
{ stage: 'transcribing', updated_at: '2026-07-10T12:45:00Z' }
{ stage: 'analyzing', transcript: '...', updated_at: '...' }
{ stage: 'generating', currentClip: 1, totalClips: 5, updated_at: '...' }
{ stage: 'validating', currentClip: 1, totalClips: 5, updated_at: '...' }
{ stage: 'scoring', currentClip: 1, totalClips: 5, updated_at: '...' }
{ stage: 'completed', clips: [...], completedAt: '...', updated_at: '...' }
```

Frontend polls every 1500ms to display real-time progress:
- Stage name (e.g., "Validating clips")
- Progress bar (currentClip / totalClips)
- Completion time estimate
- Error messages (if stage='error')

## Deployment

### Prerequisites

**System Requirements:**
- Node.js ≥16.x
- ffmpeg (audio extraction and clip cutting)
- 2GB+ RAM (for concurrent API calls)
- Access to external APIs (Grok, Claude, Gemini, Vidalis)

**Install Dependencies:**

```bash
# Install ffmpeg
# macOS
brew install ffmpeg

# Ubuntu
sudo apt-get install ffmpeg

# Windows (using Chocolatey)
choco install ffmpeg

# Or download from https://ffmpeg.org/download.html
```

**Install Python dependencies (optional Whisper fallback):**

```bash
# If you want to use local Whisper as transcription fallback
pip install openai-whisper

# Recommended model (smaller, faster)
whisper --model base  # Downloads ~139MB on first run
```

**Obtain API Keys:**

1. **Grok API Key** — for primary transcription
   - Provider: X/Grok
   - Request at: https://grok.com/api

2. **Vidalis API Key** — for clip viral scoring
   - Available in your Vidalis dashboard
   - Set VIDALIS_API_URL to your instance

3. **Claude API** — already configured (existing Anthropic setup)

4. **Gemini API** — already configured (existing Google setup)

### Installation

**1. Copy environment template:**

```bash
cd marketingDigitalBackend
cp .env.example .env.local
```

**2. Edit `.env.local` with your API keys:**

```bash
# Grok Transcription (required for fast transcription)
GROK_API_KEY=your-grok-api-key-here
GROK_API_URL=https://api.grok.com/v1

# Whisper fallback (optional)
WHISPER_MODEL_PATH=base

# Video Processing
FFMPEG_PATH=ffmpeg
CLIPS_TEMP_DIR=/tmp/repurposer-clips

# Vidalis Scoring
VIDALIS_API_URL=http://localhost:3001
VIDALIS_API_KEY=your-vidalis-api-key-here

# Logging
REPURPOSER_LOG_LEVEL=debug
```

**3. Verify environment setup:**

```bash
# Check ffmpeg is available
which ffmpeg
# Expected: /usr/bin/ffmpeg (or similar)

# Check Node.js version
node --version
# Expected: v16.x or higher

# Check environment variables are loaded
node -e "console.log(process.env.GROK_API_KEY ? '✅ GROK_API_KEY set' : '❌ GROK_API_KEY missing')"
```

**4. Run tests:**

```bash
# Unit tests (no real video required)
npm test

# Integration test (requires RUN_INTEGRATION_TESTS=true)
RUN_INTEGRATION_TESTS=true npm test

# Test only error handling
npm test -- tests/unit/errorHandling.test.js
```

### Deployment to Production

```bash
# 1. Run all tests
npm test

# 2. Check for any warnings in logs
npm run lint  # If configured

# 3. Deploy to production
git push origin feature/repurposer-multiia

# 4. Create pull request and merge to main after review
gh pr create --title "feat: add multi-IA repurposer pipeline"

# 5. Monitor deployment
tail -f logs/repurposer.log
```

## Performance Characteristics

### Processing Time Breakdown (2h video → ~8-12 clips)

| Stage | Time | Details |
|-------|------|---------|
| **Transcription** | 5-10 min | • Grok API: ~1-2 min (faster) |
| | | • Whisper (fallback): ~5-10 min (CPU-bound) |
| **Analysis** | 30-45 sec | • Claude reads transcript |
| | | • Outputs 3-8 moments |
| **Clip Cutting** | 1-2 min | • ffmpeg with -c:v copy (fast) |
| | | • ~8 clips × 10-15 sec each |
| **Validation** | 1-2 min | • 3 frames per clip × Gemini API |
| | | • Parallel processing |
| **Scoring** | 1-2 min | • Vidalis scores each clip |
| | | • Parallel processing |
| **Total** | **10-20 min** | Full pipeline for 2h video |

### Resource Usage

- **CPU:** ~30-50% during transcription/encoding
- **Memory:** ~500MB-1GB (ffmpeg + API calls)
- **Disk:** ~2-5GB temporary (clips directory)
- **Network:** ~50-100 MB (API payloads + model downloads)

### Scalability

- **Concurrent videos:** 2-3 simultaneous pipelines (depends on available RAM)
- **Database:** JSONB updates every 1-2 seconds (low load)
- **API rate limits:**
  - Grok: ~10 req/min (configurable)
  - Claude: ~10 req/min (existing limits)
  - Gemini: ~60 req/min
  - Vidalis: ~10 req/min (depends on your instance)

## Performance Tuning

### Optimization Tips

**1. Faster Transcription:**
- Use Grok API instead of local Whisper (10x faster)
- Ensure GROK_API_KEY is set and valid

**2. Optimize Clip Extraction:**
- ffmpeg is already using stream copy (`-c:v copy -c:a copy`)
- Reducing number of moments detected (e.g., max 5 instead of 8)

**3. Parallelize Validation & Scoring:**
- Clips are already validated and scored in parallel
- Increase concurrent Gemini/Vidalis requests if quotas allow

**4. Reduce Transcript Size:**
- Current: first 1000 chars sent to Claude
- Can reduce to 500 chars for faster analysis (less accurate)

**5. Cache Transcripts:**
- Store transcript in DB after stage 1
- Skip re-transcription for duplicate videos

### Configuration Tuning

```bash
# Speed up (less accurate)
REPURPOSER_LOG_LEVEL=error  # Reduce logging overhead
CLIPS_TEMP_DIR=/dev/shm     # Use RAM disk if available

# Slow down (more accurate)
REPURPOSER_LOG_LEVEL=debug  # Full logging
WHISPER_MODEL_PATH=large    # Use larger model
```

## Monitoring & Debugging

### Real-Time Monitoring

```bash
# Watch logs in real-time
tail -f logs/repurposer.log

# Filter by stage
tail -f logs/repurposer.log | grep "stage:"

# Filter by errors
tail -f logs/repurposer.log | grep "❌"
```

### Database Inspection

```sql
-- Check current pipeline state
SELECT id, ai_clips_data->>'stage' as stage, ai_clips_data->>'updated_at' as updated_at
FROM videos
WHERE ai_clips_data->>'stage' != 'completed'
ORDER BY ai_clips_data->>'updated_at' DESC;

-- Check failed pipelines
SELECT id, ai_clips_data->>'errorMessage' as error, ai_clips_data->>'errorTime' as error_time
FROM videos
WHERE ai_clips_data->>'stage' = 'error'
ORDER BY ai_clips_data->>'updated_at' DESC
LIMIT 10;

-- Get completion stats
SELECT
  COUNT(*) as total,
  COUNT(CASE WHEN ai_clips_data->>'stage' = 'completed' THEN 1 END) as completed,
  COUNT(CASE WHEN ai_clips_data->>'stage' = 'error' THEN 1 END) as errors,
  AVG(EXTRACT(EPOCH FROM (ai_clips_data->>'completedAt')::timestamp - 
              (ai_clips_data->>'created_at')::timestamp)) as avg_duration_seconds
FROM videos
WHERE ai_clips_data->>'stage' IS NOT NULL;
```

### API Quota Monitoring

```bash
# Check Grok API usage
curl -H "Authorization: Bearer ${GROK_API_KEY}" https://api.grok.com/v1/account/usage

# Check Gemini quota in Google Cloud Console
# Check Vidalis quota in your Vidalis dashboard
```

## Troubleshooting

### "Transcription unavailable: both Grok and Whisper failed"

**Symptoms:**
- Pipeline stuck in 'transcribing' stage
- Error: "Transcription unavailable"

**Solutions:**

```bash
# 1. Check GROK_API_KEY is set
echo $GROK_API_KEY  # Should not be empty

# 2. Test Grok API directly
curl -H "Authorization: Bearer ${GROK_API_KEY}" \
  https://api.grok.com/v1/speech/transcribe \
  -d '{"audio":"..."}'

# 3. Install and test Whisper fallback
pip install openai-whisper
whisper test-audio.wav --model base --language es

# 4. Verify ffmpeg can extract audio
ffmpeg -i video.mp4 -q:a 9 audio.wav
```

### "No clips could be generated"

**Symptoms:**
- Pipeline stuck in 'generating' stage
- Error: "No clips could be generated"

**Solutions:**

```bash
# 1. Verify ffmpeg is installed and in PATH
which ffmpeg  # Should return path

# 2. Test ffmpeg clip extraction manually
ffmpeg -i video.mp4 -ss 10 -to 70 -c:v copy -c:a copy clip.mp4

# 3. Check video format is supported
ffprobe -v error -show_format video.mp4

# 4. Verify detected moments have valid timestamps
# Check database: ai_clips_data.detectedMoments
```

### "Clips stuck in validating stage"

**Symptoms:**
- Progress bar stays at 20% (validating)
- No errors in database

**Solutions:**

```bash
# 1. Check Gemini API quota
# Visit Google Cloud Console > Gemini API > Quotas

# 2. Check frame extraction (ffmpeg/ffprobe)
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 video.mp4

# 3. Test Gemini Vision API
# Try a simple test image upload

# 4. Check logs for timeout errors
grep -i "timeout\|gemini" logs/repurposer.log
```

### "Low viral scores from Vidalis"

**Symptoms:**
- Clips generate successfully but viralScore is always 0 or low

**Solutions:**

```bash
# 1. Verify Vidalis is running
curl http://localhost:3001/health

# 2. Check VIDALIS_API_KEY is correct
echo $VIDALIS_API_KEY

# 3. Test Vidalis API directly
curl -X POST http://localhost:3001/vidalis/viral-score \
  -H "Authorization: Bearer ${VIDALIS_API_KEY}" \
  -d '{"videoId":"test","clipPath":"/path/to/clip.mp4",...}'

# 4. Verify clip files exist and are readable
ls -lh /tmp/repurposer-clips/
```

### "Pipeline timeout after 20 minutes"

**Symptoms:**
- Pipeline transitions to 'error' stage
- Error: "Operation timed out"

**Solutions:**

```bash
# 1. Check API rate limits haven't been exceeded
tail -f logs/repurposer.log | grep -i "rate limit"

# 2. Increase timeout values in services
# Edit timeout in each service (currently 300s for Grok, 60s for ffmpeg)

# 3. Check system resources
top  # CPU and memory usage
free -h  # Available RAM

# 4. Process smaller video or reduce number of clips
# Edit Claude prompt to request fewer moments (e.g., max 5 instead of 8)
```

### Frontend shows "Initializing" forever

**Symptoms:**
- Frontend stuck at "Initializing processing"
- Never transitions to first stage

**Solutions:**

```bash
# 1. Check database update is working
# Verify ai_clips_data column is being updated in videos table

# 2. Check frontend polling endpoint
curl http://localhost:3001/videos/{videoId}  # Should return ai_clips_data

# 3. Check frontend console for errors
# Browser DevTools > Console tab

# 4. Verify CORS is configured correctly for polling
# Check Access-Control-Allow-Origin headers
```

## Maintenance

### Cleanup

```bash
# Remove temporary clip directories (after pipeline completes or fails)
rm -rf /tmp/repurposer-clips/clips_*

# Archive old completed pipelines (after 30 days)
DELETE FROM videos WHERE ai_clips_data->>'stage' = 'completed' 
  AND ai_clips_data->>'completedAt'::timestamp < NOW() - INTERVAL '30 days';

# Cleanup error logs (keep last 7 days)
find logs/ -name "*.log" -mtime +7 -delete
```

### Updates & Upgrades

```bash
# Update transcription model
whisper --model medium  # Switch from 'base' to 'medium'

# Update Claude model
# Edit src/services/momentDetectionService.js
// Change: model: 'claude-opus-4-6'
// To: model: 'claude-opus-5' (if available)

# Update ffmpeg
brew upgrade ffmpeg  # or apt-get update && apt-get upgrade ffmpeg
```

## Error Recovery

### Retry Failed Pipelines

```bash
# If a video failed in the 'validating' stage:
# 1. Check database for error
SELECT ai_clips_data FROM videos WHERE id = 'video-id';

# 2. Fix the underlying issue (e.g., Gemini API quota)

# 3. Reset stage to trigger retry from that point
UPDATE videos 
SET ai_clips_data = jsonb_set(ai_clips_data, '{stage}', '"validating"')
WHERE id = 'video-id';

# 4. Restart worker to pick up reset video
# Kill worker: pkill -f "node.*worker"
# Restart: npm run worker
```

### Manual Pipeline Execution

```bash
# Test individual stages manually
node -e "
const { transcribeVideo } = require('./src/services/transcriptionService');
const result = await transcribeVideo('/path/to/video.mp4', 'test-id');
console.log(result);
"
```

## Support & Resources

- **Documentation:** See `/docs/`
- **Database Schema:** See `docs/DATABASE_SCHEMA.md`
- **Test Coverage:** Run `npm test`
- **Integration Tests:** `RUN_INTEGRATION_TESTS=true npm test`
- **Logs:** Check `logs/repurposer.log` for detailed errors

## Success Metrics

- ✅ **Success Rate:** >95% for valid video files
- ✅ **Processing Time:** 10-20 min for 2h video
- ✅ **Clip Quality:** 3-8 high-quality clips per video
- ✅ **User Feedback:** Real-time progress updates via 1.5s polling
- ✅ **Graceful Degradation:** Fallback strategies at each stage

---

**Last Updated:** 2026-07-10
**Version:** 1.0.0
