// @ts-check
/**
 * Layer 2 — systematic genre ontology (knowledge layer).
 *
 * A hand-built directed graph inspired by genealogy maps such as Musicmap:
 * every node knows its parents (roots), influences (cross-family edges), a
 * typical BPM range and the rhythmic traits that make up its "skeleton".
 * Children / siblings are derived. The graph is used to
 *   1. turn messy tags ("hip-hop", "edm", "j-pop") into concrete nodes,
 *   2. infer the physical genre skeleton from the measured drum traits,
 *   3. expand the search into parent / sibling / derivative genres so that a
 *      hybrid like "trap-based pop" is not lost to a coarse "Pop" tag.
 */

/**
 * @typedef {Object} GenreNode
 * @property {string} id
 * @property {string} en
 * @property {string} ja
 * @property {string[]} parents
 * @property {string[]} [influences]
 * @property {[number, number]} [bpm]
 * @property {Partial<Record<import('../types.js').TraitId, number>>} [traits]  expected trait weights (-1..1)
 * @property {string[]} [aliases]   lowercase tag spellings that map to this node
 * @property {string} [search]      iTunes search term override
 */

/** @type {GenreNode[]} */
export const GENRES = [
  // ── Roots ────────────────────────────────────────────────────────────────
  { id: 'blues', en: 'Blues', ja: 'ブルース', parents: [], bpm: [60, 120], traits: { swing: 0.6, backbeat: 0.5 } },
  { id: 'jazz', en: 'Jazz', ja: 'ジャズ', parents: ['blues'], bpm: [80, 200], traits: { swing: 1, four_on_floor: -0.5 } },
  { id: 'rnb_classic', en: 'Rhythm & Blues', ja: 'R&B（クラシック）', parents: ['blues'], bpm: [70, 130], traits: { backbeat: 1, swing: 0.4 }, aliases: ['rhythm and blues'] },
  { id: 'rock', en: 'Rock', ja: 'ロック', parents: ['rnb_classic'], bpm: [100, 160], traits: { backbeat: 1, four_on_floor: -0.4, sidechain: -0.4 }, aliases: ['rock', 'classic rock'] },
  { id: 'pop', en: 'Pop', ja: 'ポップ', parents: ['rnb_classic'], bpm: [90, 130], traits: { backbeat: 0.6 }, aliases: ['pop', 'pop music', 'mainstream'] },
  { id: 'electronic', en: 'Electronic', ja: 'エレクトロニック', parents: [], bpm: [90, 180], aliases: ['electronic', 'electronica', 'edm', 'dance', 'electro'], search: 'electronic dance' },
  { id: 'reggae', en: 'Reggae', ja: 'レゲエ', parents: ['rnb_classic'], bpm: [65, 95], traits: { halftime: 0.6, offbeat_hat: 0.5, four_on_floor: -0.6 }, aliases: ['reggae', 'roots reggae', 'one drop'] },
  { id: 'latin', en: 'Latin', ja: 'ラテン', parents: [], bpm: [85, 130], traits: { syncopated_kick: 0.5 }, aliases: ['latin', 'latino'] },

  // ── Soul / Funk / Disco lineage ──────────────────────────────────────────
  { id: 'soul', en: 'Soul', ja: 'ソウル', parents: ['rnb_classic'], bpm: [70, 120], traits: { backbeat: 1, swing: 0.3 }, aliases: ['soul', 'motown', 'classic soul'] },
  { id: 'funk', en: 'Funk', ja: 'ファンク', parents: ['soul'], bpm: [95, 125], traits: { backbeat: 1, syncopated_kick: 0.8, swing: 0.3, four_on_floor: -0.5 }, aliases: ['funk', 'p-funk'] },
  { id: 'disco', en: 'Disco', ja: 'ディスコ', parents: ['funk', 'soul'], bpm: [110, 132], traits: { four_on_floor: 1, offbeat_hat: 1, backbeat: 0.5 }, aliases: ['disco', '70s disco', 'philly soul'] },
  { id: 'boogie', en: 'Boogie / Post-Disco', ja: 'ブギー', parents: ['disco', 'funk'], bpm: [100, 122], traits: { backbeat: 1, syncopated_kick: 0.4 }, aliases: ['boogie', 'post-disco', 'post disco'] },
  { id: 'city_pop', en: 'City Pop', ja: 'シティ・ポップ', parents: ['pop', 'boogie'], influences: ['jazz_fusion', 'disco'], bpm: [95, 125], traits: { backbeat: 1, four_on_floor: 0.2 }, aliases: ['city pop', 'citypop', 'japanese city pop'] },
  { id: 'nu_disco', en: 'Nu-Disco', ja: 'ニューディスコ', parents: ['disco', 'house'], bpm: [110, 125], traits: { four_on_floor: 1, offbeat_hat: 0.9, sidechain: 0.4 }, aliases: ['nu disco', 'nu-disco', 'disco house'] },
  { id: 'disco_pop', en: 'Disco-Pop Revival', ja: 'ディスコ・ポップ', parents: ['disco', 'dance_pop'], bpm: [105, 125], traits: { four_on_floor: 1, offbeat_hat: 0.8, backbeat: 0.6 }, aliases: ['disco pop', 'nu-disco pop', 'funk pop'] },
  { id: 'neo_soul', en: 'Neo Soul', ja: 'ネオソウル', parents: ['soul', 'hiphop'], influences: ['jazz'], bpm: [65, 100], traits: { swing: 0.9, backbeat: 0.8, four_on_floor: -0.8 }, aliases: ['neo soul', 'neo-soul'] },
  { id: 'jazz_fusion', en: 'Jazz Fusion', ja: 'フュージョン', parents: ['jazz', 'funk'], bpm: [90, 140], traits: { backbeat: 0.6, syncopated_kick: 0.6 }, aliases: ['fusion', 'jazz fusion', 'jazz-funk'] },
  { id: 'acid_jazz', en: 'Acid Jazz', ja: 'アシッドジャズ', parents: ['jazz_fusion', 'funk'], influences: ['hiphop'], bpm: [95, 120], traits: { backbeat: 0.8, swing: 0.4 }, aliases: ['acid jazz'] },

  // ── Hip-hop lineage ─────────────────────────────────────────────────────────
  { id: 'hiphop', en: 'Hip-Hop', ja: 'ヒップホップ', parents: ['funk', 'disco'], bpm: [80, 100], traits: { backbeat: 1, four_on_floor: -0.8, syncopated_kick: 0.5 }, aliases: ['hip-hop', 'hip hop', 'hiphop', 'rap', 'hip-hop/rap'] },
  { id: 'boom_bap', en: 'Boom Bap', ja: 'ブーンバップ', parents: ['hiphop'], influences: ['jazz'], bpm: [84, 98], traits: { backbeat: 1, swing: 0.9, syncopated_kick: 0.6, four_on_floor: -1, rolling_hats: -0.6 }, aliases: ['boom bap', 'boom-bap', 'east coast hip hop', 'golden age hip hop'] },
  { id: 'g_funk', en: 'G-Funk', ja: 'Gファンク', parents: ['hiphop', 'funk'], bpm: [85, 100], traits: { backbeat: 1, swing: 0.4 }, aliases: ['g-funk', 'g funk', 'west coast hip hop', 'west coast rap'] },
  { id: 'lofi_hiphop', en: 'Lo-fi Hip-Hop', ja: 'ローファイ・ヒップホップ', parents: ['boom_bap'], influences: ['jazz', 'neo_soul'], bpm: [70, 92], traits: { swing: 1, backbeat: 0.8, four_on_floor: -1 }, aliases: ['lofi', 'lo-fi', 'lofi hip hop', 'chillhop', 'lo-fi hip hop'] },
  { id: 'crunk', en: 'Crunk', ja: 'クランク', parents: ['hiphop'], bpm: [70, 85], traits: { backbeat: 1, sub808: 0.6 }, aliases: ['crunk', 'southern hip hop', 'dirty south'] },
  { id: 'trap', en: 'Trap', ja: 'トラップ', parents: ['crunk', 'hiphop'], bpm: [130, 170], traits: { halftime: 1, rolling_hats: 0.9, sub808: 1, four_on_floor: -1, swing: -0.3 }, aliases: ['trap', 'trap music', 'atlanta trap'] },
  { id: 'drill', en: 'Drill', ja: 'ドリル', parents: ['trap'], bpm: [138, 148], traits: { halftime: 1, sub808: 1, rolling_hats: 0.6, syncopated_kick: 0.7, four_on_floor: -1 }, aliases: ['drill', 'chicago drill', 'uk drill', 'ny drill', 'brooklyn drill'] },
  { id: 'cloud_rap', en: 'Cloud Rap / Emo Rap', ja: 'クラウドラップ', parents: ['trap'], influences: ['chillwave'], bpm: [130, 160], traits: { halftime: 1, sub808: 0.8, rolling_hats: 0.5 }, aliases: ['cloud rap', 'emo rap', 'sad rap'] },
  { id: 'rage', en: 'Rage', ja: 'レイジ', parents: ['trap'], influences: ['trance'], bpm: [140, 170], traits: { halftime: 1, sub808: 1, rolling_hats: 0.7 }, aliases: ['rage', 'rage rap', 'plugg', 'pluggnb'] },
  { id: 'phonk', en: 'Phonk', ja: 'フォンク', parents: ['trap'], influences: ['crunk'], bpm: [125, 150], traits: { sub808: 1, halftime: 0.5, four_on_floor: 0.2 }, aliases: ['phonk', 'drift phonk', 'memphis rap'] },
  { id: 'grime', en: 'Grime', ja: 'グライム', parents: ['uk_garage', 'hiphop'], influences: ['dancehall'], bpm: [136, 144], traits: { halftime: 0.6, syncopated_kick: 0.7, four_on_floor: -0.6 }, aliases: ['grime'] },
  { id: 'jersey_club', en: 'Jersey Club', ja: 'ジャージー・クラブ', parents: ['hiphop', 'house'], bpm: [130, 145], traits: { syncopated_kick: 1, four_on_floor: -0.3 }, aliases: ['jersey club', 'baltimore club', 'club music'] },

  // ── R&B ───────────────────────────────────────────────────────────────────
  { id: 'contemporary_rnb', en: 'Contemporary R&B', ja: 'コンテンポラリーR&B', parents: ['soul', 'hiphop'], bpm: [60, 110], traits: { backbeat: 0.9, four_on_floor: -0.6 }, aliases: ['r&b', 'rnb', 'r and b', 'contemporary r&b', 'r&b/soul'] },
  { id: 'alt_rnb', en: 'Alternative R&B', ja: 'オルタナティブR&B', parents: ['contemporary_rnb'], influences: ['trap', 'chillwave'], bpm: [60, 140], traits: { halftime: 0.6, sub808: 0.6 }, aliases: ['alternative r&b', 'alt r&b', 'pbr&b', 'trap soul', 'trapsoul'] },

  // ── House / Techno / Dance ────────────────────────────────────────────────
  { id: 'house', en: 'House', ja: 'ハウス', parents: ['disco', 'electronic'], bpm: [118, 128], traits: { four_on_floor: 1, offbeat_hat: 0.8, sidechain: 0.3, halftime: -0.8 }, aliases: ['house', 'chicago house', 'house music', 'classic house'] },
  { id: 'deep_house', en: 'Deep House', ja: 'ディープハウス', parents: ['house'], influences: ['jazz', 'soul'], bpm: [115, 124], traits: { four_on_floor: 1, offbeat_hat: 0.7, swing: 0.3 }, aliases: ['deep house', 'tropical house', 'melodic house'] },
  { id: 'tech_house', en: 'Tech House', ja: 'テックハウス', parents: ['house', 'techno'], bpm: [122, 128], traits: { four_on_floor: 1, offbeat_hat: 0.9, syncopated_kick: -0.5 }, aliases: ['tech house', 'tech-house', 'minimal house'] },
  { id: 'french_house', en: 'French House', ja: 'フレンチハウス', parents: ['house', 'disco'], bpm: [118, 128], traits: { four_on_floor: 1, offbeat_hat: 0.9, sidechain: 1 }, aliases: ['french house', 'filter house', 'french touch'] },
  { id: 'progressive_house', en: 'Progressive House', ja: 'プログレッシブハウス', parents: ['house'], influences: ['trance'], bpm: [124, 130], traits: { four_on_floor: 1, sidechain: 1, offbeat_hat: 0.6 }, aliases: ['progressive house'] },
  { id: 'electro_house', en: 'Electro House', ja: 'エレクトロハウス', parents: ['house'], influences: ['electro'], bpm: [125, 132], traits: { four_on_floor: 1, sidechain: 0.9 }, aliases: ['electro house', 'complextro', 'fidget house'] },
  { id: 'big_room', en: 'Big Room', ja: 'ビッグルーム', parents: ['electro_house', 'progressive_house'], bpm: [126, 132], traits: { four_on_floor: 1, sidechain: 1 }, aliases: ['big room', 'big room house', 'festival edm'] },
  { id: 'future_house', en: 'Future House', ja: 'フューチャーハウス', parents: ['deep_house', 'electro_house'], bpm: [120, 128], traits: { four_on_floor: 1, sidechain: 0.8, offbeat_hat: 0.7 }, aliases: ['future house', 'bass house', 'slap house'] },
  { id: 'techno', en: 'Techno', ja: 'テクノ', parents: ['electro', 'house'], bpm: [125, 145], traits: { four_on_floor: 1, offbeat_hat: 0.6, backbeat: -0.3 }, aliases: ['techno', 'detroit techno', 'minimal techno', 'hard techno', 'industrial techno'] },
  { id: 'trance', en: 'Trance', ja: 'トランス', parents: ['techno'], bpm: [128, 142], traits: { four_on_floor: 1, offbeat_hat: 0.8, sidechain: 0.8 }, aliases: ['trance', 'uplifting trance', 'psytrance', 'progressive trance'] },
  { id: 'hardstyle', en: 'Hardstyle', ja: 'ハードスタイル', parents: ['trance', 'techno'], bpm: [145, 160], traits: { four_on_floor: 1, sidechain: 0.6 }, aliases: ['hardstyle', 'hardcore', 'happy hardcore', 'j-core'] },
  { id: 'uk_garage', en: 'UK Garage', ja: 'UKガラージ', parents: ['house'], influences: ['jungle', 'contemporary_rnb'], bpm: [128, 138], traits: { swing: 0.9, syncopated_kick: 0.9, four_on_floor: -0.4 }, aliases: ['uk garage', 'ukg', '2-step', '2 step', 'speed garage'] },
  { id: 'amapiano', en: 'Amapiano', ja: 'アマピアノ', parents: ['deep_house'], influences: ['jazz'], bpm: [108, 116], traits: { syncopated_kick: 0.8, sub808: 0.7, swing: 0.4 }, aliases: ['amapiano', 'log drum'] },
  { id: 'dance_pop', en: 'Dance Pop / EDM Pop', ja: 'ダンスポップ', parents: ['pop', 'house'], bpm: [112, 130], traits: { four_on_floor: 0.9, sidechain: 0.6, backbeat: 0.5 }, aliases: ['dance pop', 'dance-pop', 'edm pop', 'electropop dance', 'club'] },

  // ── Bass music ────────────────────────────────────────────────────────────
  { id: 'breakbeat', en: 'Breakbeat', ja: 'ブレイクビーツ', parents: ['hiphop', 'electronic'], bpm: [120, 140], traits: { breakbeat: 1, backbeat: 0.8, syncopated_kick: 0.8, four_on_floor: -1 }, aliases: ['breakbeat', 'breaks', 'big beat', 'nu skool breaks'] },
  { id: 'jungle', en: 'Jungle', ja: 'ジャングル', parents: ['breakbeat'], influences: ['reggae', 'dancehall'], bpm: [160, 178], traits: { breakbeat: 1, syncopated_kick: 0.9, sub808: 0.4 }, aliases: ['jungle', 'ragga jungle'] },
  { id: 'drum_and_bass', en: 'Drum & Bass', ja: 'ドラムンベース', parents: ['jungle'], bpm: [165, 178], traits: { backbeat: 0.8, syncopated_kick: 0.6, four_on_floor: -1 }, aliases: ['drum and bass', 'drum & bass', 'drum n bass', 'dnb', 'd&b', 'liquid drum and bass', 'neurofunk'] },
  { id: 'dubstep', en: 'Dubstep', ja: 'ダブステップ', parents: ['uk_garage', 'dub'], bpm: [138, 145], traits: { halftime: 1, sub808: 0.6, four_on_floor: -1 }, aliases: ['dubstep', 'riddim'] },
  { id: 'brostep', en: 'Brostep', ja: 'ブロステップ', parents: ['dubstep'], influences: ['electro_house'], bpm: [140, 150], traits: { halftime: 1, sidechain: 0.6 }, aliases: ['brostep', 'heavy dubstep', 'melodic dubstep', 'color bass'] },
  { id: 'trap_edm', en: 'EDM Trap', ja: 'EDMトラップ', parents: ['trap', 'dubstep'], bpm: [140, 155], traits: { halftime: 1, rolling_hats: 0.8, sub808: 0.9, sidechain: 0.5 }, aliases: ['edm trap', 'festival trap', 'hybrid trap'] },
  { id: 'future_bass', en: 'Future Bass', ja: 'フューチャーベース', parents: ['trap_edm', 'dubstep'], influences: ['chillwave'], bpm: [130, 160], traits: { halftime: 0.9, sidechain: 1, rolling_hats: 0.4 }, aliases: ['future bass', 'kawaii future bass', 'melodic bass'] },
  { id: 'dub', en: 'Dub', ja: 'ダブ', parents: ['reggae'], bpm: [65, 90], traits: { halftime: 0.6, sub808: 0.5 }, aliases: ['dub'] },
  { id: 'dancehall', en: 'Dancehall', ja: 'ダンスホール', parents: ['reggae'], bpm: [88, 110], traits: { dembow: 0.7, syncopated_kick: 0.7 }, aliases: ['dancehall', 'ragga'] },
  { id: 'reggaeton', en: 'Reggaeton', ja: 'レゲトン', parents: ['dancehall', 'latin'], influences: ['hiphop'], bpm: [86, 102], traits: { dembow: 1, four_on_floor: 0.8 }, aliases: ['reggaeton', 'reggaetón', 'urbano latino', 'latin urban', 'dembow'] },
  { id: 'moombahton', en: 'Moombahton', ja: 'ムーンバートン', parents: ['reggaeton', 'house'], bpm: [105, 115], traits: { dembow: 1, four_on_floor: 0.8 }, aliases: ['moombahton'] },
  { id: 'latin_pop', en: 'Latin Pop', ja: 'ラテンポップ', parents: ['latin', 'pop'], influences: ['reggaeton'], bpm: [88, 110], traits: { dembow: 0.6 }, aliases: ['latin pop', 'pop latino'] },
  { id: 'afrobeats', en: 'Afrobeats', ja: 'アフロビーツ', parents: ['dancehall', 'hiphop'], influences: ['amapiano'], bpm: [95, 115], traits: { syncopated_kick: 0.8, dembow: 0.4, swing: 0.4 }, aliases: ['afrobeats', 'afropop', 'afro pop', 'afro-fusion', 'afroswing'] },

  // ── Synth / Electronic pop ────────────────────────────────────────────────
  { id: 'electro', en: 'Electro (Funk)', ja: 'エレクトロ', parents: ['funk', 'electronic'], bpm: [105, 130], traits: { backbeat: 0.8, syncopated_kick: 0.6 }, aliases: ['electro funk', 'electro-funk', 'freestyle'] },
  { id: 'new_wave', en: 'New Wave', ja: 'ニューウェイヴ', parents: ['rock', 'pop'], bpm: [110, 150], traits: { backbeat: 1 }, aliases: ['new wave', 'post-punk'] },
  { id: 'synthpop', en: 'Synth-pop', ja: 'シンセポップ', parents: ['new_wave', 'electronic'], bpm: [100, 130], traits: { backbeat: 1, four_on_floor: 0.2 }, aliases: ['synthpop', 'synth-pop', 'synth pop', '80s'] },
  { id: 'synthwave', en: 'Synthwave', ja: 'シンセウェイヴ', parents: ['synthpop'], bpm: [80, 120], traits: { backbeat: 1, sidechain: 0.4 }, aliases: ['synthwave', 'retrowave', 'outrun', 'darksynth'] },
  { id: 'electropop', en: 'Electropop', ja: 'エレクトロポップ', parents: ['synthpop', 'dance_pop'], bpm: [100, 130], traits: { backbeat: 0.8, sidechain: 0.5 }, aliases: ['electropop', 'electro pop', 'indietronica'] },
  { id: 'chillwave', en: 'Chillwave', ja: 'チルウェイヴ', parents: ['synthpop'], influences: ['lofi_hiphop'], bpm: [80, 115], traits: { backbeat: 0.7, swing: 0.2 }, aliases: ['chillwave', 'chill', 'chillout', 'downtempo', 'vaporwave'] },
  { id: 'hyperpop', en: 'Hyperpop', ja: 'ハイパーポップ', parents: ['electropop', 'trap'], influences: ['future_bass', 'hardstyle'], bpm: [130, 180], traits: { halftime: 0.6, sub808: 0.7, sidechain: 0.5 }, aliases: ['hyperpop', 'bubblegum bass', 'digicore', 'pc music'] },
  { id: 'trap_pop', en: 'Trap-Pop', ja: 'トラップ・ポップ', parents: ['pop', 'trap'], bpm: [130, 160], traits: { halftime: 0.8, sub808: 0.9, rolling_hats: 0.6 }, aliases: ['trap pop', 'pop rap', 'pop trap', 'melodic rap'] },

  // ── Rock family ────────────────────────────────────────────────────────────
  { id: 'pop_rock', en: 'Pop Rock', ja: 'ポップロック', parents: ['rock', 'pop'], bpm: [100, 150], traits: { backbeat: 1, four_on_floor: -0.2, sidechain: -0.4 }, aliases: ['pop rock', 'power pop', 'soft rock'] },
  { id: 'indie_rock', en: 'Indie / Alternative Rock', ja: 'インディー・オルタナ', parents: ['rock'], bpm: [100, 160], traits: { backbeat: 1, sidechain: -0.5 }, aliases: ['indie', 'indie rock', 'alternative', 'alternative rock', 'alt-rock', 'shoegaze'] },
  { id: 'indie_pop', en: 'Indie Pop / Bedroom Pop', ja: 'インディーポップ', parents: ['pop', 'indie_rock'], influences: ['chillwave'], bpm: [90, 130], traits: { backbeat: 0.8 }, aliases: ['indie pop', 'bedroom pop', 'dream pop'] },
  { id: 'funk_rock', en: 'Funk Rock', ja: 'ファンクロック', parents: ['rock', 'funk'], bpm: [95, 130], traits: { backbeat: 1, syncopated_kick: 0.6 }, aliases: ['funk rock', 'funk metal'] },
  { id: 'pop_punk', en: 'Pop Punk', ja: 'ポップパンク', parents: ['rock'], bpm: [150, 200], traits: { backbeat: 1, four_on_floor: -0.2 }, aliases: ['pop punk', 'pop-punk', 'punk', 'emo', 'melodic punk'] },
  { id: 'metal', en: 'Metal', ja: 'メタル', parents: ['rock'], bpm: [90, 200], traits: { backbeat: 0.8, sidechain: -0.6 }, aliases: ['metal', 'heavy metal', 'metalcore', 'djent', 'nu metal'] },

  // ── Japan / Korea (regional pop networks) ────────────────────────────────
  { id: 'jpop', en: 'J-Pop', ja: 'J-POP', parents: ['pop'], influences: ['city_pop', 'pop_rock'], bpm: [95, 180], traits: { backbeat: 0.8 }, aliases: ['j-pop', 'jpop', 'japanese', 'japanese pop', 'j pop'], search: 'J-Pop' },
  { id: 'jrock', en: 'J-Rock', ja: 'J-ROCK', parents: ['pop_rock', 'jpop'], bpm: [120, 200], traits: { backbeat: 1, sidechain: -0.4 }, aliases: ['j-rock', 'jrock', 'japanese rock', 'visual kei'] },
  { id: 'anison', en: 'Anime Song', ja: 'アニソン', parents: ['jpop', 'jrock'], bpm: [130, 200], traits: { backbeat: 1 }, aliases: ['anime', 'anison', 'anime song', 'soundtrack'], search: 'Anime' },
  { id: 'vocaloid', en: 'Vocaloid / Net Music', ja: 'ボカロ・ネット音楽', parents: ['jpop', 'electropop'], influences: ['jrock', 'future_bass'], bpm: [130, 200], traits: { backbeat: 0.8, rolling_hats: 0.3 }, aliases: ['vocaloid', 'utaite', 'nico nico', 'niconico', 'hatsune miku', 'ボカロ'], search: 'Vocaloid' },
  { id: 'kpop', en: 'K-Pop', ja: 'K-POP', parents: ['dance_pop', 'contemporary_rnb'], influences: ['hiphop', 'trap_pop'], bpm: [95, 135], traits: { backbeat: 0.6 }, aliases: ['k-pop', 'kpop', 'korean', 'k pop'], search: 'K-Pop' },
];

/** @type {Map<string, GenreNode>} */
export const GENRE_BY_ID = new Map(GENRES.map((g) => [g.id, g]));

/** @type {Map<string, string[]>} child lists derived from parents */
export const CHILDREN = new Map();
for (const g of GENRES) {
  for (const p of g.parents) {
    if (!CHILDREN.has(p)) CHILDREN.set(p, []);
    CHILDREN.get(p)?.push(g.id);
  }
}

/** @param {string} tag */
const normTag = (tag) => tag.normalize('NFKC').toLowerCase().replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim();

/** @type {Map<string, string>} */
const ALIAS = new Map();
for (const g of GENRES) {
  ALIAS.set(normTag(g.en), g.id);
  ALIAS.set(normTag(g.ja), g.id);
  ALIAS.set(g.id.replace(/_/g, ' '), g.id);
  for (const a of g.aliases ?? []) ALIAS.set(normTag(a), g.id);
}

/**
 * Tags that say nothing about musical style (Last.fm noise).
 */
const NOISE_TAGS = new Set(['seen live', 'favorites', 'favourite', 'love', 'awesome', 'female vocalists', 'male vocalists', 'beautiful', 'spotify', 'under 2000 listeners', 'british', 'american', 'usa', 'uk', '2010s', '2020s', '00s', '90s', 'best of', 'albums i own', 'music']);

/**
 * Map a free-form tag to a genre node id.
 * @param {string} tag
 * @returns {string | null}
 */
export function tagToGenre(tag) {
  const t = normTag(tag);
  if (!t || NOISE_TAGS.has(t)) return null;
  const direct = ALIAS.get(t);
  if (direct) return direct;
  // Partial matches: "melodic dubstep" → dubstep, "japanese hip hop" → hiphop.
  // The head noun (the alias at the end of the tag) wins, then the longest alias.
  let best = null;
  let bestScore = 0;
  for (const [alias, id] of ALIAS) {
    if (alias.length < 3) continue;
    const m = new RegExp(`(^|\\s|-)${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s|-)`).exec(t);
    if (!m) continue;
    const score = (m.index + m[0].length === t.length ? 100 : 0) + alias.length;
    if (score > bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Turn weighted tags into weighted genre nodes.
 * @param {{name: string, weight: number}[]} tags
 * @returns {Map<string, number>}
 */
export function tagsToGenres(tags) {
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const { name, weight } of tags) {
    const id = tagToGenre(name);
    if (id) out.set(id, (out.get(id) ?? 0) + weight);
  }
  return out;
}

/**
 * Score every genre against measured traits + tempo (physical skeleton).
 * @param {import('../types.js').AudioFeatures} f
 * @returns {{id: string, score: number, bpmFit: number, traitFit: number}[]}
 */
export function skeletonGenres(f) {
  /** @type {{id: string, score: number, bpmFit: number, traitFit: number}[]} */
  const out = [];
  for (const g of GENRES) {
    if (!g.traits || !Object.keys(g.traits).length) continue;
    let bpmFit = 0.5;
    if (g.bpm) {
      const [lo, hi] = g.bpm;
      const fit = (/** @type {number} */ b) => {
        if (b >= lo && b <= hi) return 1;
        const d = b < lo ? Math.log2(lo / b) : Math.log2(b / hi);
        return Math.exp(-((d / 0.06) ** 2));
      };
      bpmFit = Math.max(fit(f.bpm), 0.8 * fit(f.bpm * 2), 0.8 * fit(f.bpm / 2));
    }
    let num = 0;
    let den = 0;
    for (const [trait, w] of Object.entries(g.traits)) {
      const v = f.traits[/** @type {import('../types.js').TraitId} */ (trait)];
      if (v === undefined || w === undefined) continue;
      num += w > 0 ? w * v : -w * (1 - v);
      den += Math.abs(w);
    }
    const traitFit = den ? num / den : 0.5;
    // Coverage: how much of the track's salient rhythm the genre explains
    // (a 4-on-the-floor + pumping track is not "just pop with a backbeat").
    let salient = 0;
    let covered = 0;
    for (const [trait, v] of Object.entries(f.traits)) {
      if (v < 0.5) continue;
      salient += v;
      if ((g.traits[/** @type {import('../types.js').TraitId} */ (trait)] ?? 0) > 0) covered += v;
    }
    const coverage = salient ? covered / salient : 0.5;
    out.push({ id: g.id, score: bpmFit * (0.15 + 0.5 * traitFit + 0.35 * coverage), bpmFit, traitFit });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Walk the graph outwards from seed genres.
 *   seed 1.0 · child 0.7 · parent 0.6 · influence 0.5 · sibling 0.45
 * @param {Map<string, number>} seeds genre id → weight
 * @returns {Map<string, {weight: number, relation: string, via: string}>}
 */
export function expandGenres(seeds) {
  /** @type {Map<string, {weight: number, relation: string, via: string}>} */
  const out = new Map();
  /** @param {string} id @param {number} w @param {string} relation @param {string} via */
  const add = (id, w, relation, via) => {
    if (!GENRE_BY_ID.has(id)) return;
    const prev = out.get(id);
    if (!prev || prev.weight < w) out.set(id, { weight: w, relation, via });
  };
  for (const [id, w] of seeds) {
    const g = GENRE_BY_ID.get(id);
    if (!g) continue;
    add(id, w, 'seed', id);
    for (const c of CHILDREN.get(id) ?? []) add(c, w * 0.7, 'derivative', id);
    for (const p of g.parents) {
      add(p, w * 0.6, 'parent', id);
      for (const sib of CHILDREN.get(p) ?? []) if (sib !== id) add(sib, w * 0.45, 'sibling', id);
    }
    for (const inf of g.influences ?? []) add(inf, w * 0.5, 'influence', id);
    for (const other of GENRES) if (other.influences?.includes(id)) add(other.id, w * 0.5, 'influenced', id);
  }
  return out;
}

/**
 * Ancestry path (root → … → genre) for display.
 * @param {string} id
 * @returns {string[]}
 */
export function lineage(id) {
  /** @type {string[]} */
  const path = [];
  let cur = GENRE_BY_ID.get(id);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur.id);
    cur = cur.parents.length ? GENRE_BY_ID.get(cur.parents[0]) : undefined;
  }
  return path;
}

/** @param {string} id */
export const genreLabel = (id) => {
  const g = GENRE_BY_ID.get(id);
  return g ? `${g.ja}` : id;
};

/** @param {string} id */
export const genreSearchTerm = (id) => {
  const g = GENRE_BY_ID.get(id);
  return g ? g.search ?? g.en.replace(/\s*\/.*$/, '').replace(/[()]/g, '') : id;
};
