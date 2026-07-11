---
title: Clip Impact Scoring — Design
date: 2026-07-11
author: Claude Code
status: approved-pending-implementation
---

# Clip Impact Scoring System

## Problem

The Repurposer pipeline (backend: `marketingDigitalBackend`, frontend: `marketingDigitalFrontend`) generates clips from long videos, but three things were wrong:

1. **Titles were unreadable** — cut mid-sentence (`reason.slice(0, 80)`). *(Already fixed separately — see commit `a1cf462`.)*
2. **Scores clustered around 4-6** regardless of clip quality — traced to a fabricated `historicalAvg: 5` fallback anchoring Claude's prompt. *(Already fixed — same commit.)*
3. **Clips scored via the generic marketing-framework prompt** (`generateCopyWithClaude`, 5 weighted criteria) — not tailored to short-clip virality, and the user wants a specific, more granular 7-criteria rubric instead, plus the ability to score the same clip against multiple target platforms and publish directly.

This spec covers item 3: a new, independent clip-scoring system.

## Non-goals / hard constraints

- **Do not modify** `generateCopyWithClaude`, `calibrateScore`, or any part of the existing video-scoring pipeline used for normal (non-repurposer) uploads. This is a new, parallel system.
- **Do not reuse** `viral_score`/`viral_score_real` columns for this new score — confirmed via full code trace (`vidalisController.analyzeContentStrategy`, `handleAnalyze` in `ContentCopilot.jsx`) that "AI Content Copilot" has no backing table to reuse; this is a genuinely new rubric with no prior implementation anywhere in the codebase.

## Scoring rubric

User-supplied prompt, verbatim (see prior conversation) — 7 weighted criteria summing to a 0-10 score:

| Criterion | Points |
|---|---|
| Hook / atención inicial | 0-2 |
| Retención (viewer hold rate) | 0-2 |
| Impacto emocional | 0-2 |
| Claridad del mensaje | 0-1.5 |
| Valor / propósito | 0-1.5 |
| Call-to-action / enganche | 0-1 |
| Edición & pacing | 0-0.5 |

Plus context-based adjustments (±0.5 each for educational+entertaining, surprise element, platform-native format, confusing text overlay, generic/duplicate content), clamped to 1-10.

**Extension (user-approved):** the same Claude call also returns `copy_short` and `copy_long` (the TikTok/Reels-ready caption), generated in the same response as the score — not a separate call.

## Inputs to the rubric

| Prompt placeholder | Source |
|---|---|
| `{parent_video_id}` | The clip's own `videos.id` (each clip is already a full row with the original video's id as `parent_video_id`) |
| `{duration_seconds}` | `clip.duration` (already computed) |
| `{platform}` | User-selected **before upload**, from the artist's connected platforms (`artists.active_platforms`) |
| `{niche/industria}` | Toggle on the upload form: "Usar género del artista" (default, reads `artists.ai_genre`) vs. manual override text/select for this video only |

## Data flow

```
Upload form: user picks platform (dropdown, from active_platforms)
             + niche (toggle: artist genre | manual)
                    ↓
createRepurposeVideo() stores { platform, niche } alongside the video row
                    ↓
generateClipsMultiIA pipeline runs as today through clip generation + Gemini validation
                    ↓
NEW: clipImpactScoringService scores each clip with the rubric prompt,
     parameterized by the video's stored platform + niche
                    ↓
Each clip's videos row gets: clip_impact_score (top-level, for quick display)
Each clip gets a clip_platform_scores row for {clip, platform} with the full
breakdown, strengths/weaknesses, suggestions, hashtags, copy_short/long
                    ↓
RepurposerView (persistent layout: upload form always visible, results below)
shows each clip: score, copy, hashtags, [Puntuar para otra red] [Subir a {platform}]
```

## Storage (see `sql/clip_impact_score_migration.sql`, already written — run manually in Supabase SQL Editor, no automated runner available for DDL)

- `videos.clip_impact_score DECIMAL(4,1)` — quick-display score, updated on every (re)score.
- `clip_platform_scores` table — one row per `(clip_video_id, platform)`, upserted on re-score for the same platform (creates a new row for a different platform, preserving cross-platform comparison). Columns: `score`, `score_breakdown` (jsonb), `main_strength`, `main_weakness`, `improvement_suggestion`, `viral_likelihood`, `recommended_platform`, `hashtags_suggested` (jsonb), `copy_short`, `copy_long`, timestamps.

## Backend changes

1. **New service** `clipImpactScoringService.js` — builds the rubric prompt (with the extension for copy), calls Claude, parses/validates the JSON, upserts into `clip_platform_scores`, updates `videos.clip_impact_score`. Completely independent of `aiService.generateCopyWithClaude`.
2. **Orchestrator** (`repurposerService.js`, Stage 5 "scoring"): replace the `scoreClipsWithClaude` (marketing-framework) call with `clipImpactScoringService`, using the video's stored `platform`/`niche`.
3. **`createRepurposeVideo`**: accept and store `platform`/`niche` in the request body.
4. **New endpoint** `POST /api/vidalis/clips/:clipId/rescore` `{ platform }` — re-runs the rubric for one existing clip against a different platform, upserts its `clip_platform_scores` row, updates `clip_impact_score`, returns the updated clip.
5. **Publish**: no new endpoint — reuses existing `POST /api/vidalis/publish-now/:videoId` (each clip already has its own video id).
6. **Main gallery** (`fetchArtistGallery` in `vidalisService.js`): currently filters `is('parent_video_id', null)`, hiding all clips. Per the original ask ("deberían aparecer en el catálogo viral"), remove this filter so clips render alongside original uploads, using `clip_impact_score` in place of `viral_score` for rows where `parent_video_id` is set.

## Frontend changes

1. **Upload form** (`RepurposerView.jsx`): add a platform selector (pills/dropdown, options = `activePlatforms` prop) and a niche toggle ("Usar género del artista" checkbox + conditional text input).
2. **Layout restructure**: replace the current phase-exclusive `if (phase === X) return <...>` full-screen swaps with a persistent layout — upload form always rendered, processing indicator and results grid render below it based on state, so the user never loses access to "upload another video" while viewing results.
3. **Clip card component**: score (from `clip_impact_score`), `copy_short` shown, hashtags, expandable breakdown (7 sub-scores + strengths/weaknesses/suggestion), **"Puntuar para otra red"** button (platform picker → calls the rescore endpoint → updates the card in place), **"Subir a {platform}"** button (calls existing publish-now endpoint).
4. **`VideoGallery.jsx`**: read `clip_impact_score` for rows with `parent_video_id` set, `viral_score` otherwise (both feed the existing `ScoreBadge`).

## Testing

- `clipImpactScoringService`: unit tests mirroring `clipScoringService.test.js`'s patterns (mock Claude, verify prompt construction, verify upsert shape, verify score clamping/validation, resilience on Claude failure).
- Rescore endpoint: integration-style test verifying it creates a new `clip_platform_scores` row for a new platform and updates (not duplicates) for a repeat platform.
- `createRepurposeVideo`: verify `platform`/`niche` are persisted.
- Frontend: manual verification (per this project's `verify` skill) — upload flow with platform/niche selection, results appear below the form, rescore button changes displayed score, publish button fires the existing publish flow.
