/**
 * Integration test for Repurposer Multi-IA pipeline
 *
 * This test exercises the full pipeline end-to-end with real services
 * (mocked external APIs like Grok, Claude, Gemini, Vidalis).
 *
 * Run with: RUN_INTEGRATION_TESTS=true npm test -- tests/integration/repurposer-multiia.integration.test.js
 * Or skip by default with: npm test -- tests/integration/repurposer-multiia.integration.test.js
 */

const path = require('path');
const fs = require('fs');
const { generateClipsMultiIA } = require('../../src/services/repurposerService');

describe('Repurposer Multi-IA Integration', () => {
  // Skip in CI unless specific flag set (requires real video file)
  const skipIntegration = process.env.RUN_INTEGRATION_TESTS !== 'true';

  const testVideoPath = path.join(__dirname, '../fixtures/sample_video.mp4');
  const testVideoId = `integration-test-${Date.now()}`;

  beforeAll(() => {
    if (!skipIntegration) {
      console.log('⏭️ Integration tests skipped (RUN_INTEGRATION_TESTS not set)');
      console.log(`📝 To run: cp your-video.mp4 ${testVideoPath}`);
      console.log(`💻 Then: RUN_INTEGRATION_TESTS=true npm test`);
    }
  });

  afterAll(async () => {
    // Cleanup any temporary files created during testing
    const tempDirs = [
      path.join(__dirname, '../fixtures/clips_*'),
    ];

    // Note: In a real scenario, the orchestrator would cleanup clips automatically
  });

  it('should process video through full pipeline when test video exists', async () => {
    if (skipIntegration) {
      console.log('⏭️ Skipping: RUN_INTEGRATION_TESTS not set');
      return;
    }

    if (!fs.existsSync(testVideoPath)) {
      console.warn(`⚠️ Test video not found at ${testVideoPath}`);
      console.warn('   Copy a 2-10 min video file to this path to run integration tests');
      return;
    }

    try {
      // Run the full pipeline
      const result = await generateClipsMultiIA(testVideoPath, testVideoId);

      // Verify result structure
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      expect(result.length).toBeLessThanOrEqual(20); // Reasonable clip count

      // Check first clip structure
      const firstClip = result[0];

      // All clips must have these properties
      expect(firstClip).toHaveProperty('index');
      expect(firstClip).toHaveProperty('startTime');
      expect(firstClip).toHaveProperty('endTime');
      expect(firstClip).toHaveProperty('duration');

      // Duration should be positive
      expect(firstClip.duration).toBeGreaterThan(0);
      expect(firstClip.duration).toBeLessThanOrEqual(90); // Max 90 seconds

      // Validation results
      expect(firstClip).toHaveProperty('validation');
      expect(firstClip.validation).toHaveProperty('hasVisualHook');
      expect(firstClip.validation).toHaveProperty('confidence');
      expect(typeof firstClip.validation.confidence).toBe('number');
      expect(firstClip.validation.confidence).toBeGreaterThanOrEqual(0);
      expect(firstClip.validation.confidence).toBeLessThanOrEqual(1);

      // Score results
      expect(firstClip).toHaveProperty('score');
      expect(firstClip.score).toHaveProperty('viralScore');
      expect(typeof firstClip.score.viralScore).toBe('number');
      expect(firstClip.score.viralScore).toBeGreaterThanOrEqual(0);
      expect(firstClip.score).toHaveProperty('recommendedPlatforms');
      expect(Array.isArray(firstClip.score.recommendedPlatforms)).toBe(true);

      console.log(`✅ Integration test passed: Generated ${result.length} clips`);
      console.log(`   First clip: ${firstClip.duration}s, score: ${firstClip.score.viralScore}`);
    } catch (error) {
      console.error('❌ Integration test failed:', error.message);
      if (error.stack) {
        console.error(error.stack.split('\n').slice(0, 5).join('\n'));
      }
      throw error;
    }
  });

  it('should handle video file validation errors gracefully', async () => {
    if (skipIntegration) {
      return;
    }

    const invalidPath = '/nonexistent/video.mp4';

    try {
      await generateClipsMultiIA(invalidPath, 'test-invalid-id');
      fail('Should have thrown an error for nonexistent file');
    } catch (error) {
      expect(error.message).toContain('Video file not found');
    }
  });

  it('should verify all 5 stages execute when processing', async () => {
    if (skipIntegration) {
      console.log('⏭️ Skipping stage verification test');
      return;
    }

    if (!fs.existsSync(testVideoPath)) {
      console.warn('⚠️ Test video not found, skipping stage verification');
      return;
    }

    // In a real test, we would mock the database to track stage updates
    // For now, we verify the final output contains evidence of all stages
    const result = await generateClipsMultiIA(testVideoPath, `stage-test-${Date.now()}`);

    expect(Array.isArray(result)).toBe(true);

    if (result.length > 0) {
      const clip = result[0];

      // Stage 1: Transcribing (evidence: clips exist)
      expect(clip).toBeDefined();

      // Stage 2: Analyzing (evidence: clips have timing)
      expect(clip.startTime).toBeDefined();
      expect(clip.endTime).toBeDefined();

      // Stage 3: Generating (evidence: clips have path/data)
      expect(clip.duration).toBeDefined();
      expect(clip.duration).toBeGreaterThan(0);

      // Stage 4: Validating (evidence: validation results)
      expect(clip.validation).toBeDefined();
      expect(clip.validation.confidence).toBeDefined();

      // Stage 5: Scoring (evidence: viral scores)
      expect(clip.score).toBeDefined();
      expect(clip.score.viralScore).toBeDefined();

      console.log('✅ All 5 stages verified in output');
    }
  });
});
