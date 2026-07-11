---
title: Repurposer Multi-IA System Design
date: 2026-07-10
author: Claude Code
status: draft
---

# Repurposer Multi-IA System: Video to Clips Pipeline

## Overview

Replace current single-threaded video processing with a **smart multi-IA pipeline** that uses each AI tool for its strength:
- **Grok/Whisper**: Audio transcription (fast, local)
- **Claude**: Narrative analysis & moment detection (text understanding)
- **Gemini Vision**: Visual validation of clips (frame analysis, not full video)
- **Vidalis API**: Final clip scoring & viral potential

**Result**: Process 2h videos in ~5-10 minutes instead of hanging on Gemini's 584MB video processing.

---

## Current Problems

1. **Performance bottleneck**: Video 2h (584MB) sent to Gemini → times out, fails, retries
2. **UX issue**: Frontend shows "Detectando..." with no progress indication
3. **Architecture**: Video complete → Gemini analyzes → cuts clips (backwards)

## Proposed Solution

**New flow**: Transcribe → Analyze text → Cut clips locally → Validate clips → Score clips

### Data Flow

```
Input: Video file (2h, ~584MB)
  ↓
[STAGE 1] Transcribe Audio
  • Extract audio stream from video
  • Use Grok Speech API or local Whisper model
  • Output: Transcription with timestamps + speaker info
  • Duration: ~5-10 min (parallel/local)
  ↓
[STAGE 2] Analyze with Claude
  • Send ONLY the transcript (not video)
  • Claude detects narrative peaks, emotional moments, hooks
  • Output: List of moments with start/end times + confidence scores
  • Duration: ~30 sec (text processing)
  ↓
[STAGE 3] Cut Clips (Local ffmpeg)
  • Use Claude's timestamps to cut video
  • Generate 15-90s clips (no reencoding, just segmentation)
  • Output: Clip files ready for validation
  • Duration: ~1-2 min (local, linear with clip count)
  ↓
[STAGE 4] Validate Clips (Gemini Vision)
  • Extract 2-3 key frames from EACH CLIP (not full video)
  • Gemini analyzes frames + clip metadata
  • Validates "visual hook" quality
  • Output: Clip confidence scores, visual improvements needed
  • Duration: ~1-2 min (parallel requests per clip)
  ↓
[STAGE 5] Score Clips (Vidalis API)
  • Send validated clips to Vidalis
  • Get viral scores, platform recommendations
  • Output: Final scored clips ready for display
  • Duration: ~1-2 min (parallel)
  ↓
Result: 5-8 high-quality clips with scores
```

---

## Backend Implementation

### 1. Transcription Service (`src/services/transcriptionService.js`)

**New module** that handles audio extraction + transcription.

```javascript
async function transcribeVideo(videoPath, videoId) {
  // 1. Extract audio from video
  const audioPath = await extractAudio(videoPath);
  
  // 2. Transcribe using Grok API (fallback: local Whisper)
  const transcript = await transcribeWithGrok(audioPath, {
    language: 'es',
    timestamps: true,
  });
  
  // 3. Update database with transcript
  await updateVideoClipsData(videoId, {
    stage: 'transcribed',
    transcript: transcript.text,
    transcriptSegments: transcript.segments,
    updatedAt: new Date(),
  });
  
  return transcript;
}
```

**Grok Integration** (new dependency):
- Use Grok API for fast Spanish transcription
- Fallback to local Whisper model if Grok unavailable
- Store transcript + segments in DB

### 2. Moment Detection Service (`src/services/momentDetectionService.js`)

**New module** that analyzes transcript with Claude.

```javascript
async function detectMomentsWithClaude(transcript, videoTitle, videoId) {
  const prompt = `
    Eres un editor experto en videos virales. Analiza la siguiente transcripción 
    y detecta entre 3-8 momentos que funcionen como clips independientes de 15-90s.
    
    Para cada momento:
    - Identifica inicio/fin (en segundos)
    - Explica por qué es un buen gancho
    - Asigna confianza (0-1)
    
    Ordena por potencial viral, de mayor a menor.
    
    Transcripción:
    ${transcript}
  `;
  
  const response = await getAnthropic().messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });
  
  const moments = parseClaudeResponse(response.content[0].text);
  
  await updateVideoClipsData(videoId, {
    stage: 'moments_detected',
    detectedMoments: moments,
    updatedAt: new Date(),
  });
  
  return moments;
}
```

**Input**: Transcript (text only — fast)
**Output**: `[{start, end, reason, confidence, tags}, ...]`

### 3. Clip Generation Service (`src/services/clipGenerationService.js`)

**Refactor existing** to use local ffmpeg with Claude's timestamps.

```javascript
async function generateClips(videoPath, moments, videoId) {
  const clips = [];
  
  for (const [i, moment] of moments.entries()) {
    const clipPath = `${tmpDir}/clip_${i}.mp4`;
    
    // FFmpeg: cut without re-encoding (fast)
    await cutVideoSegment(videoPath, clipPath, moment.start, moment.end, {
      codec: 'copy', // No reencoding = fast
    });
    
    clips.push({
      index: i,
      path: clipPath,
      momentId: moment.id,
      startTime: moment.start,
      endTime: moment.end,
    });
    
    // Emit progress event
    emitProgress(videoId, {
      stage: 'generating',
      currentClip: i + 1,
      totalClips: moments.length,
    });
  }
  
  await updateVideoClipsData(videoId, {
    stage: 'clips_generated',
    clipCount: clips.length,
    updatedAt: new Date(),
  });
  
  return clips;
}
```

**Input**: Video path + Claude's moments
**Output**: Clip files (no quality loss, fast — copy codec)

### 4. Clip Validation Service (`src/services/clipValidationService.js`)

**New module** for Gemini frame analysis.

```javascript
async function validateClipsWithGemini(clips, videoId) {
  const validatedClips = [];
  
  for (const [i, clip] of clips.entries()) {
    // Extract 2-3 key frames from clip (not entire video)
    const frames = await extractKeyFrames(clip.path, {
      count: 3,
      timing: ['start', 'middle', 'end'],
    });
    
    // Analyze frames with Gemini Vision
    const analysis = await analyzeClipFramesWithGemini(frames, clip.momentId);
    
    validatedClips.push({
      ...clip,
      validation: {
        hasVisualHook: analysis.hasHook,
        confidenceScore: analysis.confidence,
        suggestions: analysis.improvements,
        analyzedAt: new Date(),
      },
    });
    
    emitProgress(videoId, {
      stage: 'validating',
      currentClip: i + 1,
      totalClips: clips.length,
    });
  }
  
  await updateVideoClipsData(videoId, {
    stage: 'validated',
    validatedClips,
    updatedAt: new Date(),
  });
  
  return validatedClips;
}
```

**Input**: Clip files (small segments)
**Output**: Validation metadata (not full analysis)

### 5. Main Orchestrator (`src/services/repurposerService.js` - refactor)

**Orchestrate** the new pipeline:

```javascript
async function generateClipsMultiIA(videoPath, parentVideoId) {
  try {
    // 1. Transcribe
    logDebug(`🎯 [Repurposer] ${parentVideoId} → etapa: transcribing`);
    const transcript = await transcribeVideo(videoPath, parentVideoId);
    
    // 2. Detect moments with Claude
    logDebug(`🎯 [Repurposer] ${parentVideoId} → etapa: analyzing`);
    const moments = await detectMomentsWithClaude(
      transcript.text,
      '', // videoTitle from DB
      parentVideoId
    );
    
    // 3. Generate clips locally
    logDebug(`🎯 [Repurposer] ${parentVideoId} → etapa: generating`);
    const clips = await generateClips(videoPath, moments, parentVideoId);
    
    // 4. Validate with Gemini (frames only)
    logDebug(`🎯 [Repurposer] ${parentVideoId} → etapa: validating`);
    const validatedClips = await validateClipsWithGemini(clips, parentVideoId);
    
    // 5. Score with Vidalis
    logDebug(`🎯 [Repurposer] ${parentVideoId} → etapa: scoring`);
    const scoredClips = await scoreClipsWithVidalis(validatedClips, parentVideoId);
    
    // 6. Save final results
    await updateVideoClipsData(parentVideoId, {
      stage: 'completed',
      clips: scoredClips,
      completedAt: new Date(),
    });
    
  } catch (error) {
    logError(`❌ [Repurposer] ${parentVideoId} failed: ${error.message}`);
    await updateVideoClipsData(parentVideoId, {
      stage: 'error',
      errorMessage: error.message,
    });
  }
}
```

---

## Database Schema

### Update `ai_clips_data` column

Current:
```json
{
  "stage": "detecting",
  "updated_at": "2026-07-10T12:49:54.373Z"
}
```

New (expanded):
```json
{
  "stage": "validating",
  "currentClip": 3,
  "totalClips": 5,
  "transcript": "...",
  "detectedMoments": [...],
  "clips": [...],
  "validationResults": [...],
  "finalScores": [...],
  "errors": null,
  "timings": {
    "transcription": 420,
    "analysis": 30,
    "generation": 90,
    "validation": 120
  },
  "updated_at": "2026-07-10T12:50:30.000Z"
}
```

---

## Frontend Changes

### Real-time Progress Updates

**API Endpoint** (`GET /videos/:videoId`):
```json
{
  "ai_clips_data": {
    "stage": "validating",
    "progress": {
      "currentClip": 3,
      "totalClips": 5,
      "stageDescription": "Validando calidad de clips"
    }
  }
}
```

### Loading Screen Component

```tsx
const stages = [
  { id: 'transcribe', label: '📝 Transcribiendo audio', icon: '🎙️' },
  { id: 'analyze', label: '🧠 Analizando momentos', icon: '✨' },
  { id: 'generate', label: '✂️ Generando clips', icon: '🎬' },
  { id: 'validate', label: '✅ Validando calidad', icon: '🔍' },
  { id: 'score', label: '⭐ Calculando score', icon: '📊' },
];

function LoadingProgress({ data }) {
  const currentStageIndex = stages.findIndex(s => s.id === data.stage);
  
  return (
    <div className="loading-container">
      <div className="progress-stages">
        {stages.map((stage, idx) => (
          <div key={stage.id} className={`stage ${idx <= currentStageIndex ? 'active' : 'pending'}`}>
            <span className="icon">{stage.icon}</span>
            <span className="label">{stage.label}</span>
            {idx === currentStageIndex && data.currentClip && (
              <span className="progress">{data.currentClip}/{data.totalClips}</span>
            )}
          </div>
        ))}
      </div>
      <ProgressBar value={currentStageIndex + 1} max={stages.length} />
      <p className="eta">Tiempo estimado: 5-10 minutos</p>
    </div>
  );
}
```

### Polling Strategy (Option C)

```javascript
useEffect(() => {
  const interval = setInterval(async () => {
    const video = await fetch(`/videos/${videoId}`);
    setProgress(video.ai_clips_data);
    
    // Stop polling when complete
    if (['completed', 'error'].includes(video.ai_clips_data.stage)) {
      clearInterval(interval);
      showResults();
    }
  }, 1500); // Poll every 1.5 seconds
  
  return () => clearInterval(interval);
}, [videoId]);
```

---

## Dependencies & Tools

### Backend
- **Grok API** (transcription) — or fallback Whisper
- **Claude Opus 4.6** (analysis) — already in use
- **Gemini 2.5** (validation) — already in use
- **ffmpeg** (clip generation) — local binary
- **Node.js child_process** (orchestration)

### Frontend
- React hooks (useEffect, useState)
- Existing API client (already set up)

---

## Success Criteria

✅ Video 2h processed in < 10 minutes (vs. current timeout)
✅ No Gemini calls with full video (only frame analysis)
✅ Frontend shows real-time progress with stage + clip count
✅ 5-8 high-quality clips generated per video
✅ Clips scored and ready for Vidalis immediately
✅ Error handling with clear user feedback

---

## Timeline Estimate

- Transcription service: 2h
- Moment detection (Claude integration): 1.5h
- Clip generation (ffmpeg refactor): 1.5h
- Validation service (Gemini frames): 2h
- Frontend loading component: 1.5h
- Testing & integration: 2h
- **Total: ~10h work**

---

## Error Handling & Fallbacks

### Transcription Failures
- If Grok fails → Fallback to local Whisper model
- If both fail → Show user error "Audio no pudo ser procesado"
- Retry logic: 2 attempts with exponential backoff

### Claude Analysis Failures
- If Claude times out → Fallback: Use generic moment detection (scene cuts)
- If generic detection fails → Show error to user
- Log detailed error for debugging

### Clip Generation Failures
- If ffmpeg fails on a clip → Skip that moment, continue with others
- If > 50% clips fail → Show error "No se pudieron generar suficientes clips"
- Store error log in DB

### Gemini Validation Failures
- If Gemini errors on a clip → Mark as "unvalidated" but continue
- If > 50% validations fail → Continue to Vidalis scoring anyway
- Unvalidated clips get confidence: 0.5 (medium confidence)

### Vidalis Scoring Failures
- If Vidalis API fails → Store clips with status "pending_score"
- Retry scoring in background every 5 minutes
- User can still see clips but no viral scores yet

### Frontend Polling
- If status endpoint fails → Show "Conectando..." spinner
- After 3 failed polls → Show "Error de conexión, reintentando..."
- Auto-retry every 5 seconds up to 2 minutes
- After timeout → Show "El procesamiento tardó más de lo esperado"

---

## Progress Event Emission

Backend emits progress to DB `ai_clips_data` every time:
1. Transcription completes → `stage: 'transcribed'`
2. Each Claude moment detected → `stage: 'analyzing'` + increment counter
3. Each clip generated → `stage: 'generating'` + `currentClip: X/Y`
4. Each clip validated → `stage: 'validating'` + `currentClip: X/Y`
5. Vidalis scoring → `stage: 'scoring'` + `currentClip: X/Y`
6. All complete → `stage: 'completed'`

Frontend polls `GET /videos/:videoId` every 1.5 seconds to fetch updated progress.

---

## Rollout Plan

1. **Phase 1**: Deploy backend services (no frontend changes)
   - Run parallel with current system
   - Test with sample videos

2. **Phase 2**: Activate new pipeline for new uploads
   - Keep old system for existing queued jobs

3. **Phase 3**: Update frontend loading screen
   - Show new progress stages
   - Add real-time polling

4. **Phase 4**: Monitor & optimize
   - Gather metrics on timing per stage
   - Adjust Grok vs. Whisper based on quality/cost
