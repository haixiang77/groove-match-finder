import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanYoutubeTitle, parseTrackUrl, pickBestMatch, resolveTrackUrl, UrlSourceError } from '../src/services/url-source.js';

test('Apple Music album link with ?i= yields the track id and country', () => {
  const p = parseTrackUrl('https://music.apple.com/jp/album/some-song/1234567?i=7654321');
  assert.deepEqual(p, { kind: 'apple', trackId: 7654321, country: 'JP' });
});

test('Apple Music /song/ link and itunes.apple.com host', () => {
  assert.equal(parseTrackUrl('https://music.apple.com/us/song/name/999').trackId, 999);
  assert.equal(parseTrackUrl('https://itunes.apple.com/us/album/x/1?i=42&uo=4').trackId, 42);
});

test('Apple album-only / playlist links are rejected in Japanese', () => {
  assert.throws(() => parseTrackUrl('https://music.apple.com/jp/album/x/123'), (e) => e instanceof UrlSourceError && /アルバム/.test(e.message));
  assert.throws(() => parseTrackUrl('https://music.apple.com/jp/playlist/x/pl.abc'), UrlSourceError);
});

test('YouTube URL variants resolve to a video id', () => {
  for (const u of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10',
    'https://youtu.be/dQw4w9WgXcQ?si=x',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
  ]) {
    const p = parseTrackUrl(u);
    assert.equal(p.kind, 'youtube');
    assert.equal(p.videoId, 'dQw4w9WgXcQ');
  }
});

test('invalid, empty and unsupported URLs throw Japanese errors', () => {
  assert.throws(() => parseTrackUrl(''), /入力/);
  assert.throws(() => parseTrackUrl('not a url'), /形式/);
  assert.throws(() => parseTrackUrl('ftp://music.apple.com/jp/song/x/1'), /http/);
  assert.throws(() => parseTrackUrl('https://open.spotify.com/track/abc'), /未対応/);
  assert.throws(() => parseTrackUrl('https://www.youtube.com/watch?v=short'), UrlSourceError);
  assert.throws(() => parseTrackUrl('https://www.youtube.com/'), UrlSourceError);
});

test('resolveTrackUrl rejects bad URLs before any network access', async () => {
  await assert.rejects(resolveTrackUrl('https://example.com/x', { country: 'JP', proxy: '' }), /未対応/);
});

test('cleanYoutubeTitle strips noise and splits artist - title', () => {
  assert.deepEqual(cleanYoutubeTitle('Daft Punk - One More Time (Official Video)'), { artist: 'Daft Punk', title: 'One More Time' });
  assert.deepEqual(cleanYoutubeTitle('Just A Title', 'Some Artist - Topic'), { artist: 'Some Artist', title: 'Just A Title' });
});

/** @param {number} id @param {string} artist @param {string} name */
const hit = (id, artist, name) => ({ trackId: id, trackName: name, artistName: artist });

test('pickBestMatch picks a clear match and refuses ambiguous / poor ones', () => {
  const guess = { artist: 'Daft Punk', title: 'One More Time' };
  assert.equal(pickBestMatch(guess, [hit(1, 'Daft Punk', 'One More Time'), hit(2, 'Other', 'Zzz')]).best?.trackId, 1);
  assert.equal(pickBestMatch(guess, [hit(3, 'Someone', 'Unrelated Thing')]).best, null);
  const amb = pickBestMatch({ artist: '', title: 'Intro' }, [hit(4, 'A', 'Intro'), hit(5, 'B', 'Intro Remix Long Name')]);
  assert.ok(amb.ranked.length === 2);
});
