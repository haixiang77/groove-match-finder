// @ts-check
/**
 * Shared JSDoc type definitions + runtime schemas for the analysis payloads.
 * (The browser equivalent of the Pydantic models in the original Python spec.)
 */
import { s } from './schema.js';

/** @typedef {'kick' | 'snare' | 'hat'} DrumBand */
export const DRUM_BANDS = /** @type {const} */ (['kick', 'snare', 'hat']);

/**
 * Frequency bands used for the 16-step drum grid (Hz). Same split as the
 * original SciPy Butterworth implementation.
 */
export const BAND_RANGES = {
  kick: { lo: 30, hi: 140 },
  snare: { lo: 160, hi: 1500 },
  hat: { lo: 6000, hi: null },
};

/** Spectral balance bands (Hz) for timbre comparison. */
export const BALANCE_BANDS = [
  { id: 'sub', label: 'Sub', lo: 20, hi: 60 },
  { id: 'bass', label: 'Bass', lo: 60, hi: 250 },
  { id: 'lowmid', label: 'Low-Mid', lo: 250, hi: 2000 },
  { id: 'highmid', label: 'Hi-Mid', lo: 2000, hi: 6000 },
  { id: 'air', label: 'Air', lo: 6000, hi: 11000 },
];

const grid16 = s.array(s.number({ min: 0, max: 1 }), { min: 16, max: 16 });

export const RhythmGridSchema = s.object({ kick: grid16, snare: grid16, hat: grid16 });
/** @typedef {{kick: number[], snare: number[], hat: number[]}} RhythmGrid */

export const KeyEstimateSchema = s.object({
  tonic: s.number({ min: 0, max: 11, int: true }),
  mode: s.enum(/** @type {const} */ (['major', 'minor'])),
  name: s.string(),
  camelot: s.string(),
  confidence: s.number({ min: 0, max: 1 }),
});
/** @typedef {{tonic: number, mode: 'major' | 'minor', name: string, camelot: string, confidence: number}} KeyEstimate */

export const AudioFeaturesSchema = s.object({
  version: s.number(),
  durationSec: s.number({ min: 0 }),
  bpm: s.number({ min: 30, max: 300 }),
  bpmConfidence: s.number({ min: 0, max: 1 }),
  bpmCandidates: s.array(s.number()),
  key: KeyEstimateSchema,
  grid: RhythmGridSchema,
  presence: s.object({ kick: s.number(), snare: s.number(), hat: s.number() }),
  groove: s.object({
    swing: s.number({ min: 0, max: 100 }),
    swingUnit: s.number(),
    swingConfidence: s.number({ min: 0, max: 1 }),
    sidechainDb: s.number(),
    subSustain: s.number(),
    hatDensity: s.number(),
    kickDensity: s.number(),
  }),
  spectral: s.object({
    centroidHz: s.number(),
    rolloffHz: s.number(),
    crestDb: s.number(),
    rmsDb: s.number(),
    bandBalance: s.array(s.number(), { min: 5, max: 5 }),
  }),
  traits: s.object({
    four_on_floor: s.number(),
    offbeat_hat: s.number(),
    backbeat: s.number(),
    halftime: s.number(),
    rolling_hats: s.number(),
    sub808: s.number(),
    swing: s.number(),
    sidechain: s.number(),
    syncopated_kick: s.number(),
    dembow: s.number(),
    breakbeat: s.number(),
  }),
  beatCount: s.number(),
});

/**
 * @typedef {Object} GrooveMetrics
 * @property {number} swing            Swing in percent (50 = straight, 66.7 = triplet)
 * @property {number} swingUnit        8 or 16 (which subdivision is swung)
 * @property {number} swingConfidence  0..1
 * @property {number} sidechainDb      Depth of beat-synchronous "pumping" in dB
 * @property {number} subSustain       0..1, long sustained subs (808) → high
 * @property {number} hatDensity       Fraction of 16 steps with strong hat hits
 * @property {number} kickDensity      Fraction of 16 steps with strong kick hits
 */

/**
 * @typedef {Object} SpectralProfile
 * @property {number} centroidHz
 * @property {number} rolloffHz
 * @property {number} crestDb
 * @property {number} rmsDb
 * @property {number[]} bandBalance  dB of each BALANCE_BANDS entry relative to total
 */

/**
 * @typedef {'four_on_floor'|'offbeat_hat'|'backbeat'|'halftime'|'rolling_hats'|'sub808'|'swing'|'sidechain'|'syncopated_kick'|'dembow'|'breakbeat'} TraitId
 * @typedef {Record<TraitId, number>} Traits
 */

/**
 * @typedef {Object} AudioFeatures
 * @property {number} version
 * @property {number} durationSec
 * @property {number} bpm
 * @property {number} bpmConfidence
 * @property {number[]} bpmCandidates
 * @property {KeyEstimate} key
 * @property {RhythmGrid} grid
 * @property {Record<DrumBand, number>} presence
 * @property {GrooveMetrics} groove
 * @property {SpectralProfile} spectral
 * @property {Traits} traits
 * @property {number} beatCount
 */

/**
 * @typedef {'manual'|'audd'|'acrcloud'|'gemini'|'filename'} IdentificationSource
 * @typedef {Object} Identification
 * @property {string} title
 * @property {string} artist
 * @property {IdentificationSource} source
 * @property {number} confidence
 * @property {string} [album]
 * @property {string} [isrc]
 * @property {string} [appleMusicId]
 * @property {string[]} [genreTags]
 * @property {string} [soundDesign]
 */

/**
 * @typedef {Object} Candidate
 * @property {string} key             normalised artist|title
 * @property {string} artist
 * @property {string} title
 * @property {string[]} sources       e.g. ['lastfm:similar', 'itunes:genre:house']
 * @property {number} weight          accumulated prior relevance from metadata sources
 * @property {string} [previewUrl]
 * @property {string} [artworkUrl]
 * @property {string} [trackViewUrl]
 * @property {string} [genre]
 * @property {number} [itunesId]
 * @property {string} [album]
 * @property {number} [releaseYear]
 * @property {File} [localFile]
 */

/**
 * @typedef {Object} ScoreBreakdown
 * @property {number} rhythm
 * @property {number} tempo
 * @property {number} groove
 * @property {number} timbre
 * @property {number} key
 */

/**
 * @typedef {Object} ScoredCandidate
 * @property {Candidate} candidate
 * @property {AudioFeatures} features
 * @property {number} score
 * @property {ScoreBreakdown} breakdown
 * @property {{kick: number, snare: number, hat: number}} bandSimilarity
 * @property {number} shiftSteps       Bar rotation used for the best grid alignment
 * @property {number} tempoRatio       1, 2 or 0.5 (half/double-time match)
 * @property {string[]} reasons        Rule-based explanation lines (Japanese)
 * @property {boolean} passed
 */

export {};
