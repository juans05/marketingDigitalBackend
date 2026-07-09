const { buildClipUrl } = require('../../src/services/repurposerService');

describe('buildClipUrl', () => {
  test('inserta so_/eo_ antes del public ID para una URL de Cloudinary válida', () => {
    const url = 'https://res.cloudinary.com/demo/video/upload/v1700000000/vidalis_uploads/podcast.mp4';
    const result = buildClipUrl(url, 30, 75);
    expect(result).toBe('https://res.cloudinary.com/demo/video/upload/so_30,eo_75/v1700000000/vidalis_uploads/podcast.mp4');
  });

  test('funciona con start en 0', () => {
    const url = 'https://res.cloudinary.com/demo/video/upload/v1700000000/vidalis_uploads/podcast.mp4';
    const result = buildClipUrl(url, 0, 45);
    expect(result).toBe('https://res.cloudinary.com/demo/video/upload/so_0,eo_45/v1700000000/vidalis_uploads/podcast.mp4');
  });

  test('lanza error si la URL no es de Cloudinary', () => {
    expect(() => buildClipUrl('https://example.com/video.mp4', 0, 10)).toThrow('no es de Cloudinary');
  });

  test('lanza error si la URL de Cloudinary no tiene el formato esperado (sin v<numero>/)', () => {
    const url = 'https://res.cloudinary.com/demo/video/upload/podcast.mp4';
    expect(() => buildClipUrl(url, 0, 10)).toThrow('no estándar');
  });
});
