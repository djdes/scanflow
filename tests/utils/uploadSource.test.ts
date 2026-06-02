import { describe, it, expect } from 'vitest';
import { inferUploadSource } from '../../src/utils/uploadSource';

describe('inferUploadSource', () => {
  it("returns 'camera' for the mobile camera filename pattern", () => {
    expect(inferUploadSource('photo_1717326000000_abc-12.jpg')).toBe('camera');
    expect(inferUploadSource('photo_42_x.png')).toBe('camera');
  });

  it("returns 'web' for a plain dashboard upload (no filename query)", () => {
    expect(inferUploadSource(undefined)).toBe('web');
    expect(inferUploadSource('')).toBe('web');
  });

  it("returns 'web' for a filename that does not match the camera pattern", () => {
    expect(inferUploadSource('invoice-scan.jpg')).toBe('web');
    expect(inferUploadSource('photo_no_extension')).toBe('web');
    expect(inferUploadSource('photo_abc_def.jpg')).toBe('web'); // first group must be digits
  });
});
