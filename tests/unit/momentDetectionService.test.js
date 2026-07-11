process.env.ANTHROPIC_API_KEY = 'test-key';

const { detectMomentsWithClaude } = require('../../src/services/momentDetectionService');

// Mock getAnthropic
jest.mock('../../src/lib/anthropic', () => ({
  getAnthropic: jest.fn(),
}));

const { getAnthropic } = require('../../src/lib/anthropic');

afterEach(() => jest.clearAllMocks());

describe('momentDetectionService', () => {
  describe('detectMomentsWithClaude', () => {
    test('should detect moments from transcript with mocked Claude response', async () => {
      const mockResponse = {
        content: [{
          type: 'text',
          text: JSON.stringify({
            moments: [
              {
                index: 1,
                start: 10,
                end: 60,
                reason: 'Strong hook with surprising reveal',
                confidence: 0.95,
                tags: ['storytelling', 'hook', 'surprise']
              },
              {
                index: 2,
                start: 100,
                end: 180,
                reason: 'Emotional moment with relatability',
                confidence: 0.85,
                tags: ['emotional', 'storytelling']
              }
            ]
          })
        }]
      };

      getAnthropic.mockReturnValue({
        messages: {
          create: jest.fn().mockResolvedValue(mockResponse)
        }
      });

      const moments = await detectMomentsWithClaude(
        'This is a sample transcript with interesting moments...',
        'Sample Video Title',
        'video-123'
      );

      expect(moments).toHaveLength(2);
      expect(moments[0]).toEqual({
        index: 1,
        start: 10,
        end: 60,
        reason: 'Strong hook with surprising reveal',
        confidence: 0.95,
        tags: ['storytelling', 'hook', 'surprise']
      });
      expect(moments[1]).toEqual({
        index: 2,
        start: 100,
        end: 180,
        reason: 'Emotional moment with relatability',
        confidence: 0.85,
        tags: ['emotional', 'storytelling']
      });
    });

    test('should reject empty transcript', async () => {
      await expect(
        detectMomentsWithClaude('', 'Sample Video', 'video-123')
      ).rejects.toThrow('Transcript cannot be empty');
    });

    test('should reject whitespace-only transcript', async () => {
      await expect(
        detectMomentsWithClaude('   \n\t  ', 'Sample Video', 'video-123')
      ).rejects.toThrow('Transcript cannot be empty');
    });

    test('should validate moment timestamps and reject invalid durations', async () => {
      const mockResponse = {
        content: [{
          type: 'text',
          text: JSON.stringify({
            moments: [
              {
                index: 1,
                start: 10,
                end: 12,  // Too short (only 2 seconds, min is 15)
                reason: 'Short clip',
                confidence: 0.8,
                tags: ['hook']
              },
              {
                index: 2,
                start: 100,
                end: 200,  // Too long (100 seconds, max is 90)
                reason: 'Long clip',
                confidence: 0.8,
                tags: ['storytelling']
              },
              {
                index: 3,
                start: 300,
                end: 350,  // Valid (50 seconds)
                reason: 'Valid moment',
                confidence: 0.9,
                tags: ['emotional']
              }
            ]
          })
        }]
      };

      getAnthropic.mockReturnValue({
        messages: {
          create: jest.fn().mockResolvedValue(mockResponse)
        }
      });

      const moments = await detectMomentsWithClaude('Valid transcript text');

      // Only the valid moment should remain
      expect(moments).toHaveLength(1);
      expect(moments[0].start).toBe(300);
      expect(moments[0].end).toBe(350);
    });

    test('should clamp confidence values to 0.0-1.0 range', async () => {
      const mockResponse = {
        content: [{
          type: 'text',
          text: JSON.stringify({
            moments: [
              {
                index: 1,
                start: 10,
                end: 60,
                reason: 'Test',
                confidence: 1.5,  // Too high, should clamp to 1.0
                tags: ['test']
              },
              {
                index: 2,
                start: 70,
                end: 120,
                reason: 'Test',
                confidence: -0.5,  // Too low, should clamp to 0.0
                tags: ['test']
              }
            ]
          })
        }]
      };

      getAnthropic.mockReturnValue({
        messages: {
          create: jest.fn().mockResolvedValue(mockResponse)
        }
      });

      const moments = await detectMomentsWithClaude('Sample transcript');

      expect(moments[0].confidence).toBe(1.0);
      expect(moments[1].confidence).toBe(0.0);
    });

    test('should truncate reason to 200 characters', async () => {
      const longReason = 'A'.repeat(300);
      const mockResponse = {
        content: [{
          type: 'text',
          text: JSON.stringify({
            moments: [
              {
                index: 1,
                start: 10,
                end: 60,
                reason: longReason,
                confidence: 0.8,
                tags: ['test']
              }
            ]
          })
        }]
      };

      getAnthropic.mockReturnValue({
        messages: {
          create: jest.fn().mockResolvedValue(mockResponse)
        }
      });

      const moments = await detectMomentsWithClaude('Sample transcript');

      expect(moments[0].reason.length).toBe(200);
    });

    test('should limit tags to first 5', async () => {
      const mockResponse = {
        content: [{
          type: 'text',
          text: JSON.stringify({
            moments: [
              {
                index: 1,
                start: 10,
                end: 60,
                reason: 'Test',
                confidence: 0.8,
                tags: ['tag1', 'tag2', 'tag3', 'tag4', 'tag5', 'tag6', 'tag7']
              }
            ]
          })
        }]
      };

      getAnthropic.mockReturnValue({
        messages: {
          create: jest.fn().mockResolvedValue(mockResponse)
        }
      });

      const moments = await detectMomentsWithClaude('Sample transcript');

      expect(moments[0].tags).toHaveLength(5);
      expect(moments[0].tags).toEqual(['tag1', 'tag2', 'tag3', 'tag4', 'tag5']);
    });

    test('should filter out moments with invalid timestamps', async () => {
      const mockResponse = {
        content: [{
          type: 'text',
          text: JSON.stringify({
            moments: [
              {
                index: 1,
                start: 10,
                end: 50,
                reason: 'Valid',
                confidence: 0.8,
                tags: ['valid']
              },
              {
                index: 2,
                start: 'invalid',  // Non-numeric
                end: 80,
                reason: 'Invalid',
                confidence: 0.8,
                tags: ['invalid']
              },
              {
                index: 3,
                start: 90,
                end: 80,  // end < start
                reason: 'Invalid',
                confidence: 0.8,
                tags: ['invalid']
              }
            ]
          })
        }]
      };

      getAnthropic.mockReturnValue({
        messages: {
          create: jest.fn().mockResolvedValue(mockResponse)
        }
      });

      const moments = await detectMomentsWithClaude('Sample transcript');

      expect(moments).toHaveLength(1);
      expect(moments[0].start).toBe(10);
    });

    test('should throw error if no valid moments after filtering', async () => {
      const mockResponse = {
        content: [{
          type: 'text',
          text: JSON.stringify({
            moments: [
              {
                index: 1,
                start: 10,
                end: 12,  // Too short
                reason: 'Invalid',
                confidence: 0.8,
                tags: ['invalid']
              }
            ]
          })
        }]
      };

      getAnthropic.mockReturnValue({
        messages: {
          create: jest.fn().mockResolvedValue(mockResponse)
        }
      });

      await expect(
        detectMomentsWithClaude('Sample transcript')
      ).rejects.toThrow('No valid moments detected');
    });

    test('should throw error on invalid Claude response format', async () => {
      getAnthropic.mockReturnValue({
        messages: {
          create: jest.fn().mockResolvedValue({
            content: [{
              type: 'text',
              text: 'Not JSON at all'
            }]
          })
        }
      });

      await expect(
        detectMomentsWithClaude('Sample transcript')
      ).rejects.toThrow('Invalid Claude response format');
    });

    test('should order moments by confidence (highest first)', async () => {
      const mockResponse = {
        content: [{
          type: 'text',
          text: JSON.stringify({
            moments: [
              {
                index: 1,
                start: 10,
                end: 60,
                reason: 'Lower confidence',
                confidence: 0.6,
                tags: ['test']
              },
              {
                index: 2,
                start: 70,
                end: 120,
                reason: 'Higher confidence',
                confidence: 0.95,
                tags: ['test']
              },
              {
                index: 3,
                start: 130,
                end: 180,
                reason: 'Medium confidence',
                confidence: 0.8,
                tags: ['test']
              }
            ]
          })
        }]
      };

      getAnthropic.mockReturnValue({
        messages: {
          create: jest.fn().mockResolvedValue(mockResponse)
        }
      });

      const moments = await detectMomentsWithClaude('Sample transcript');

      // Should be ordered by confidence: 0.95, 0.8, 0.6
      expect(moments[0].confidence).toBe(0.95);
      expect(moments[1].confidence).toBe(0.8);
      expect(moments[2].confidence).toBe(0.6);
    });

    test('should handle missing reason field', async () => {
      const mockResponse = {
        content: [{
          type: 'text',
          text: JSON.stringify({
            moments: [
              {
                index: 1,
                start: 10,
                end: 60,
                // Missing reason field
                confidence: 0.8,
                tags: ['test']
              }
            ]
          })
        }]
      };

      getAnthropic.mockReturnValue({
        messages: {
          create: jest.fn().mockResolvedValue(mockResponse)
        }
      });

      const moments = await detectMomentsWithClaude('Sample transcript');

      expect(moments).toHaveLength(1);
      expect(moments[0].reason).toBe('');
    });

    test('should handle missing tags field', async () => {
      const mockResponse = {
        content: [{
          type: 'text',
          text: JSON.stringify({
            moments: [
              {
                index: 1,
                start: 10,
                end: 60,
                reason: 'Test moment',
                confidence: 0.8
                // Missing tags field
              }
            ]
          })
        }]
      };

      getAnthropic.mockReturnValue({
        messages: {
          create: jest.fn().mockResolvedValue(mockResponse)
        }
      });

      const moments = await detectMomentsWithClaude('Sample transcript');

      expect(moments).toHaveLength(1);
      expect(moments[0].tags).toEqual([]);
    });
  });
});
