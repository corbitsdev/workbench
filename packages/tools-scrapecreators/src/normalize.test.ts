import { describe, expect, it } from 'bun:test';
import {
  normalizeTikTokPost,
  normalizeInstagramPost,
  normalizeThreadsPost,
  normalizePinterestPin,
} from './normalize';

describe('normalizeTikTokPost', () => {
  it('maps a full fixture to the expected fields', () => {
    const result = normalizeTikTokPost({
      id: 'vid_123',
      url: 'https://www.tiktok.com/@creator/video/vid_123',
      desc: 'Amazing product demo video',
      createTime: 1700000000,
      likes: 4200,
      comments: 18,
      author: 'creator',
    });

    expect(result.url).toBe('https://www.tiktok.com/@creator/video/vid_123');
    expect(result.title).toBe('Amazing product demo video');
    expect(result.publishedAt).toBe(new Date(1700000000 * 1000).toISOString());
    expect(result.author).toBe('creator');
    expect(result.engagement.upvotes).toBe(4200);
    expect(result.engagement.comments).toBe(18);
    expect(result.source).toBe('tiktok');
  });

  it('falls back gracefully when fields are missing', () => {
    const result = normalizeTikTokPost({ id: 'vid_456' });

    expect(result.url).toContain('vid_456');
    expect(result.title).toBe('');
    expect(result.author).toBe('');
    expect(result.engagement.upvotes).toBe(0);
    expect(result.publishedAt).toBeTruthy();
  });
});

describe('normalizeInstagramPost', () => {
  it('maps a full fixture to the expected fields', () => {
    const result = normalizeInstagramPost({
      code: 'ABC123',
      caption: 'First line\nSecond line of caption',
      takenAt: '2024-11-14T12:00:00.000Z',
      likes: 800,
      comments: 9,
      author: 'brandaccount',
    });

    expect(result.url).toBe('https://www.instagram.com/reel/ABC123');
    expect(result.title).toBe('First line');
    expect(result.publishedAt).toBe('2024-11-14T12:00:00.000Z');
    expect(result.author).toBe('brandaccount');
    expect(result.engagement.upvotes).toBe(800);
    expect(result.engagement.comments).toBe(9);
    expect(result.source).toBe('instagram');
  });

  it('converts a unix taken_at to ISO', () => {
    const result = normalizeInstagramPost({ code: 'XYZ', takenAt: 1700100000 });
    expect(result.publishedAt).toBe(new Date(1700100000 * 1000).toISOString());
  });

  it('treats a millisecond taken_at as milliseconds, not seconds', () => {
    const result = normalizeInstagramPost({ code: 'XYZ', takenAt: 1700100000000 });
    expect(result.publishedAt).toBe(new Date(1700100000000).toISOString());
  });

  it('falls back gracefully when fields are missing', () => {
    const result = normalizeInstagramPost({});

    expect(result.url).toBe('https://instagram.com');
    expect(result.title).toBe('');
    expect(result.author).toBe('');
    expect(result.engagement.upvotes).toBe(0);
    expect(result.publishedAt).toBeTruthy();
  });
});

describe('normalizeThreadsPost', () => {
  it('maps a full fixture to the expected fields', () => {
    const result = normalizeThreadsPost({
      code: 'Abc1DefG',
      text: 'Short threads post',
      taken_at: 1700100000,
      like_count: 55,
      user: { username: 'threaduser' },
    });

    expect(result.url).toBe('https://www.threads.net/t/Abc1DefG');
    expect(result.title).toBe('Short threads post');
    expect(result.publishedAt).toBe(new Date(1700100000 * 1000).toISOString());
    expect(result.author).toBe('threaduser');
    expect(result.engagement.upvotes).toBe(55);
    expect(result.engagement.comments).toBe(0);
    expect(result.source).toBe('threads');
  });

  it('falls back gracefully when fields are missing', () => {
    const result = normalizeThreadsPost({});

    expect(result.url).toBe('https://www.threads.net');
    expect(result.title).toBe('');
    expect(result.author).toBe('');
    expect(result.engagement.upvotes).toBe(0);
    expect(result.publishedAt).toBeTruthy();
  });
});

describe('normalizePinterestPin', () => {
  it('maps a full fixture to the expected fields', () => {
    const result = normalizePinterestPin({
      id: 'pin_789',
      title: 'Beautiful Recipe',
      description: 'A detailed recipe description',
      created_at: '2024-10-01T08:00:00Z',
      save_count: 320,
      pinner: { username: 'pinner_user' },
    });

    expect(result.url).toBe('https://pinterest.com/pin/pin_789');
    expect(result.title).toBe('Beautiful Recipe');
    expect(result.summary).toBe('A detailed recipe description');
    expect(result.publishedAt).toBe('2024-10-01T08:00:00Z');
    expect(result.author).toBe('pinner_user');
    expect(result.engagement.upvotes).toBe(320);
    expect(result.engagement.comments).toBe(0);
    expect(result.source).toBe('pinterest');
  });

  it('falls back gracefully when fields are missing', () => {
    const result = normalizePinterestPin({});

    expect(result.url).toBe('https://pinterest.com');
    expect(result.title).toBe('');
    expect(result.author).toBe('');
    expect(result.engagement.upvotes).toBe(0);
    expect(result.publishedAt).toBeTruthy();
  });

  it('normalizes an epoch-string created_at to ISO', () => {
    const result = normalizePinterestPin({ id: 'p1', created_at: '1700000000' });
    expect(result.publishedAt).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('uses description first line as title when title is absent', () => {
    const result = normalizePinterestPin({
      description: 'Pin description first line\nMore text',
    });
    expect(result.title).toBe('Pin description first line');
  });
});
