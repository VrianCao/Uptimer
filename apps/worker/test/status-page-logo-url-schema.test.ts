import { describe, expect, it } from 'vitest';

import {
  createStatusPageInputSchema,
  parseLogoUrlInput,
  patchStatusPageInputSchema,
} from '../src/schemas/status-pages';

describe('logo url normalization', () => {
  it.each([
    ['https://example.com/logo.png', 'https://example.com/logo.png'],
    ['https://example.com/a/b.svg?x=1#frag', 'https://example.com/a/b.svg?x=1#frag'],
    ['http://cdn.example.net/brand.png', 'http://cdn.example.net/brand.png'],
    ['  https://example.com/logo.png  ', 'https://example.com/logo.png'],
  ])('accepts %s -> %s', (input, expected) => {
    expect(parseLogoUrlInput(input)).toBe(expected);
  });

  it.each([
    'not-a-url',
    'ftp://example.com/logo.png',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://',
    'https://example.com/' + 'a'.repeat(2100),
    '/relative/path.png',
    'data:image/png;base64,AAAA',
  ])('rejects %s by returning null', (input) => {
    expect(parseLogoUrlInput(input)).toBeNull();
  });

  it('treats empty, null, and undefined as a clear', () => {
    expect(parseLogoUrlInput('')).toBeNull();
    expect(parseLogoUrlInput(null)).toBeNull();
    expect(parseLogoUrlInput(undefined)).toBeNull();
  });
});

describe('createStatusPageInputSchema', () => {
  it('defaults logo_url to null', () => {
    const parsed = createStatusPageInputSchema.parse({
      slug: 'partners',
      name: 'Partners',
      title: 'Partner status',
      monitor_ids: [1],
    });
    expect(parsed.logo_url).toBeNull();
  });

  it('accepts an http(s) URL string (normalization happens at route level)', () => {
    const parsed = createStatusPageInputSchema.parse({
      slug: 'partners',
      name: 'Partners',
      title: 'Partner status',
      logo_url: 'https://example.com/logo.png',
      monitor_ids: [1],
    });
    expect(parsed.logo_url).toBe('https://example.com/logo.png');
  });

  it('accepts empty string (route clears to null)', () => {
    const parsed = createStatusPageInputSchema.parse({
      slug: 'partners',
      name: 'Partners',
      title: 'Partner status',
      logo_url: '',
      monitor_ids: [1],
    });
    expect(parsed.logo_url).toBe('');
  });

  it('accepts null to clear', () => {
    const parsed = createStatusPageInputSchema.parse({
      slug: 'partners',
      name: 'Partners',
      title: 'Partner status',
      logo_url: null,
      monitor_ids: [1],
    });
    expect(parsed.logo_url).toBeNull();
  });
});

describe('patchStatusPageInputSchema', () => {
  it('preserves undefined logo_url as a no-op', () => {
    const parsed = patchStatusPageInputSchema.parse({ name: 'New name' });
    expect(parsed.logo_url).toBeUndefined();
  });

  it('accepts an http(s) URL string (normalization happens at route level)', () => {
    const parsed = patchStatusPageInputSchema.parse({ logo_url: 'https://example.com/logo.png' });
    expect(parsed.logo_url).toBe('https://example.com/logo.png');
  });

  it('accepts empty monitor_ids (unlink all)', () => {
    const parsed = patchStatusPageInputSchema.parse({ monitor_ids: [] });
    expect(parsed.monitor_ids).toEqual([]);
  });

  it('accepts empty string (route clears to null)', () => {
    const parsed = patchStatusPageInputSchema.parse({ logo_url: '' });
    expect(parsed.logo_url).toBe('');
  });
});
