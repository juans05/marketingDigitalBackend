# Database Schema: Multi-IA Pipeline

## Overview

The `ai_clips_data` column in the `videos` table stores the state and progress of the multi-IA repurposing pipeline. This document describes the schema, fields, and their usage.

## Schema

```json
{
  "stage": "transcribing|analyzing|generating|validating|scoring|completed|error",
  "currentClip": 2,
  "totalClips": 5,
  "clipCount": 5,
  "transcript": "First 1000 characters of the full transcript...",
  "detectedMoments": [
    {
      "index": 0,
      "start": 120,
      "end": 180,
      "reason": "Strong hook with emotional impact",
      "confidence": 0.95,
      "tags": ["storytelling", "emotional"]
    }
  ],
  "clips": [
    {
      "index": 0,
      "startTime": 120,
      "endTime": 180,
      "duration": 60,
      "validation": {
        "hasVisualHook": true,
        "confidence": 0.85,
        "suggestions": ["Increase contrast"],
        "analyzedAt": "2026-07-10T12:50:30.000Z"
      },
      "score": {
        "viralScore": 8.5,
        "scoreBreakdown": {
          "hook": 9,
          "retention": 8,
          "shareability": 8
        },
        "recommendedPlatforms": ["tiktok", "reels"],
        "scoredAt": "2026-07-10T12:51:00.000Z"
      }
    }
  ],
  "errorMessage": "Optional error message if stage='error'",
  "errorTime": "2026-07-10T12:52:00.000Z",
  "updated_at": "2026-07-10T12:50:30.000Z",
  "completedAt": "2026-07-10T12:52:30.000Z"
}
```

## Field Definitions

### stage (string, required)
Current processing stage:
- `transcribing`: Extracting audio and transcribing to text
- `analyzing`: Detecting narrative moments with Claude
- `generating`: Cutting video clips from moments
- `validating`: Analyzing clip frames with Gemini Vision
- `scoring`: Calculating viral potential with Vidalis
- `completed`: Pipeline finished successfully
- `error`: Pipeline encountered an error

### currentClip (number, optional)
For multi-clip progress tracking during `generating` and `validating` stages.
Represents the current clip being processed (1-indexed).

### totalClips (number, optional)
Total number of clips in the current processing stage.
Used to calculate progress percentage on frontend.

### clipCount (number, optional)
Final count of clips generated and scored.
Populated when `stage = 'completed'`.

### transcript (string, optional)
First 1000 characters of the full transcript.
Stored for reference and debugging. Full transcript stored separately if needed.

### detectedMoments (array, optional)
Array of narrative moments detected by Claude:
- `index`: Zero-indexed position in moments list
- `start`: Moment start time in seconds
- `end`: Moment end time in seconds
- `reason`: Why this moment was detected (e.g., "Strong hook with emotional impact")
- `confidence`: Confidence score (0.0-1.0)
- `tags`: Array of tags (e.g., ["storytelling", "emotional"])

### clips (array, optional)
Array of final clip data with validation and scoring results.
Each clip object contains:
- `index`: Clip index
- `startTime`: Start time in seconds
- `endTime`: End time in seconds
- `duration`: Duration in seconds (endTime - startTime)
- `validation`: Gemini Vision analysis results (see below)
- `score`: Vidalis scoring results (see below)

#### validation sub-object
- `hasVisualHook`: Boolean indicating visual engagement
- `confidence`: Confidence score (0.0-1.0)
- `suggestions`: Array of improvement suggestions
- `analyzedAt`: ISO timestamp of analysis
- `error`: Optional error message if analysis failed

#### score sub-object
- `viralScore`: Overall viral potential (0-10)
- `scoreBreakdown`: Component scores (hook, retention, shareability)
- `recommendedPlatforms`: Array of platforms (e.g., ["tiktok", "reels", "youtube_shorts"])
- `scoredAt`: ISO timestamp of scoring
- `error`: Optional error message if scoring failed

### errorMessage (string, optional)
Human-readable error message if `stage = 'error'`.
Used to display to user or for debugging.

### errorTime (ISO string, optional)
ISO timestamp when the error occurred.
Helps track when the pipeline failed.

### updated_at (ISO string, required)
ISO timestamp of last update to this record.
Updated at every stage transition.

### completedAt (ISO string, optional)
ISO timestamp when pipeline completed successfully.
Only present when `stage = 'completed'`.

## Backward Compatibility

The schema is fully backward compatible with existing records:

- Old records with only `stage` and `updated_at` fields will continue to work
- New optional fields (currentClip, totalClips, clips, etc.) can be safely ignored by old code
- New code gracefully handles missing fields with defaults

Example old record (still valid):
```json
{
  "stage": "completed",
  "updated_at": "2026-07-09T10:30:00.000Z"
}
```

## Usage in Code

### Frontend Progress Polling

```javascript
const response = await fetch(`/videos/${videoId}`);
const video = await response.json();
const { ai_clips_data } = video;

// Display current stage
console.log(`Stage: ${ai_clips_data.stage}`);

// Display progress bar (multi-clip stages)
if (ai_clips_data.currentClip && ai_clips_data.totalClips) {
  const progress = (ai_clips_data.currentClip / ai_clips_data.totalClips) * 100;
  console.log(`Progress: ${progress}%`);
}

// Handle completion
if (ai_clips_data.stage === 'completed') {
  console.log(`Generated ${ai_clips_data.clipCount} clips`);
  displayClips(ai_clips_data.clips);
}

// Handle errors
if (ai_clips_data.stage === 'error') {
  console.error(`Error: ${ai_clips_data.errorMessage}`);
}
```

### Backend Stage Updates

```javascript
const { supabase } = require('../lib/supabase');

async function updateClipsData(videoId, data) {
  const { data: existingVideo } = await supabase
    .from('videos')
    .select('ai_clips_data')
    .eq('id', videoId)
    .single();

  const currentData = existingVideo.ai_clips_data || {};
  const newData = {
    ...currentData,
    ...data,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('videos')
    .update({ ai_clips_data: newData })
    .eq('id', videoId);

  if (error) throw error;
}

// Usage
await updateClipsData(videoId, { stage: 'transcribing' });
await updateClipsData(videoId, { stage: 'analyzing', transcript: '...' });
```

## Performance Considerations

- The `ai_clips_data` JSONB column is indexed for fast lookups
- Update interval: ~1-2 seconds per stage transition
- Frontend polling interval: 1500ms (configurable)
- Clips array can be large (10-20MB for 2h video with 20 clips) — consider lazy loading

## Future Enhancements

1. Archive old clips to separate storage after retention period
2. Add retry logic and resilience tracking
3. Support for parallel multi-language transcription
4. Progressive field encryption for sensitive data
