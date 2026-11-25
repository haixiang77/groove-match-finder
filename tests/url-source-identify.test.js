import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identifyYoutubeTrack, pickBestMatch } from '../src/services/url-source.js';

/** @param {number} id @param {string} artist @param {string} name */
const hit = (id, artist, name) => ({ trackId: id, trackName: name, artistName: artist });

test('unique exact title is accepted despite Japanese/romaji artist mismatch', () => {
  const guess = { artist: 'Yoasobi', title: 'アイドル' };
  const r = pickBestMatch(guess, [hit(1, 'YOASOBI', 'アイドル'), hit(2, '別人', 'まったく違う曲')]);
  assert.equal(r.best?.trackId, 1);
  const g2 = { artist: 'Utada Hikaru', title: 'First Love' };
  assert.equal(pickBestMatch(g2, [hit(3, '宇多田ヒカル', 'First Love')]).best?.trackId, 3);
});

test('title contained in the guess (or vice versa) counts as strong when unique', () => {
  const r = pickBestMatch({ artist: 'Foo', title: 'Dream On feat. Bar' }, [hit(1, 'フー', 'Dream On')]);
  assert.equal(r.best?.trackId, 1);
});

test('same-title different songs stay ambiguous and are rejected', () => {
  const r = pickBestMatch({ artist: 'ローマ字', title: 'Intro' }, [hit(1, 'A', 'Intro'), hit(2, 'B', 'Intro')]);
  assert.equal(r.best, null);
});

test('falls back to a title-only search when artist+title yields nothing acceptable', async () => {
  /** @type {string[]} */
  const terms = [];
  const r = await identifyYoutubeTrack({ artist: 'Yoasobi', title: 'アイドル' }, async (term) => {
    terms.push(term);
    return term === 'アイドル' ? [hit(7, 'YOASOBI', 'アイドル')] : [hit(9, 'Someone', 'Unrelated')];
  });
  assert.deepEqual(terms, ['Yoasobi アイドル', 'アイドル']);
  assert.equal(r.best?.trackId, 7);
});

test('no fallback search when the first search already succeeds', async () => {
  let calls = 0;
  const r = await identifyYoutubeTrack({ artist: 'Daft Punk', title: 'One More Time' }, async () => {
    calls++;
    return [hit(1, 'Daft Punk', 'One More Time')];
  });
  assert.equal(calls, 1);
  assert.equal(r.best?.trackId, 1);
});
