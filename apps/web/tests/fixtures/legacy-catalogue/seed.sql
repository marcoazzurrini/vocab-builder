-- Starter deck: 50 French entries — 35 words, 15 chunks (the 70/30 ratio, §7).
--
-- This is scaffolding content, not the real deck. §3.2 replaces it with a
-- subtitle-derived frequency list of ~500–1000 content lemmas. It exists so the
-- pipeline can be exercised end to end before the content job starts.
--
-- Shipped as a migration rather than supabase/seed.sql because `db push` does
-- not carry seed files, so a hosted project would otherwise come up with an
-- empty deck. When the real list lands it will want a proper idempotent script
-- instead of an ever-growing migration chain.
--
--
-- ORDER (freq_rank 1–50)
--
-- These are curated introduction positions, NOT corpus frequency ranks — this
-- deck was hand-picked, and writing fake ranks would be lying in the data.
-- They occupy freq_rank because intro order is what the column drives, and once
-- the real list arrives the two coincide.
--
-- The sequence is deliberately anti-clustered per §5: related items are pushed
-- far apart, never batched. chien 6 / chat 35 / oiseau 22 / poisson 46;
-- soleil 48 / lune 11; femme 13 / homme 41; grand 7 / petit 21;
-- chaud 36 / froid 14; merci beaucoup 5 / de rien 42;
-- je ne sais pas 19 / je ne comprends pas 49. Words and chunks interleave, and
-- so do nouns (23), verbs (7) and adjectives (5).
--
--
-- CHUNK ANSWERS — two decisions this seed forces, which the client must match
--
-- 1. No trailing punctuation. Stored as `qu'est-ce que c'est`, not
--    `qu'est-ce que c'est ?`. French puts a space before `?`, and requiring the
--    user to type that is testing typography, not vocabulary. The gloss keeps
--    its question mark since it is only ever displayed.
--
-- 2. Straight apostrophes (U+0027), never typographic (U+2019). Phone and
--    desktop keyboards disagree about which they emit, so the comparison must
--    normalise both to the same character — the same reasoning that makes the
--    oe/œ ligature tolerated while accents stay strict.
--
-- Comparison must also collapse internal whitespace. Accents remain strict:
-- `s'il vous plait` is wrong, exactly as `fenetre` is.
--
--
-- IMAGES
--
-- Null for every chunk (§3.1 — chunks rarely map to an image; the Italian
-- phrase is the prompt) and for the adjectives whose emoji would be ambiguous.
-- An unclear image is worse than none: §2 wants one *clean* exposure.

insert into public.words (lang, text, gloss, hint, image, kind, freq_rank) values
  ('fr', 'eau',                  'acqua',              null,                        '💧',   'word',  1),
  ('fr', 'bonjour',              'buongiorno',         null,                        null,   'chunk', 2),
  ('fr', 'manger',               'mangiare',           null,                        '🍽️',  'word',  3),
  ('fr', 'maison',               'casa',               null,                        '🏠',   'word',  4),
  ('fr', 'merci beaucoup',       'grazie mille',       null,                        null,   'chunk', 5),
  ('fr', 'chien',                'cane',               null,                        '🐶',   'word',  6),
  ('fr', 'grand',                'grande',             null,                        null,   'word',  7),
  ('fr', 'je voudrais',          'vorrei',             'per ordinare qualcosa',      null,   'chunk', 8),
  ('fr', 'pain',                 'pane',               null,                        '🍞',   'word',  9),
  ('fr', 'voir',                 'vedere',             null,                        '👁️',  'word',  10),
  ('fr', 'lune',                 'luna',               null,                        '🌙',   'word',  11),
  ('fr', 's''il vous plaît',     'per favore',         'forma di cortesia',          null,   'chunk', 12),
  ('fr', 'femme',                'donna',              null,                        '👩',   'word',  13),
  ('fr', 'froid',                'freddo',             null,                        '🥶',   'word',  14),
  ('fr', 'livre',                'libro',              null,                        '📖',   'word',  15),
  ('fr', 'qu''est-ce que c''est','che cos''è?',        null,                        null,   'chunk', 16),
  ('fr', 'boire',                'bere',               null,                        '🥤',   'word',  17),
  ('fr', 'fleur',                'fiore',              null,                        '🌸',   'word',  18),
  ('fr', 'je ne sais pas',       'non lo so',          null,                        null,   'chunk', 19),
  ('fr', 'voiture',              'macchina',           'automobile',                 '🚗',   'word',  20),
  ('fr', 'petit',                'piccolo',            null,                        null,   'word',  21),
  ('fr', 'oiseau',               'uccello',            null,                        '🐦',   'word',  22),
  ('fr', 'comment ça va',        'come va?',           null,                        null,   'chunk', 23),
  ('fr', 'porte',                'porta',              null,                        '🚪',   'word',  24),
  ('fr', 'parler',               'parlare',            null,                        '💬',   'word',  25),
  ('fr', 'temps',                'tempo',              'la durata, non il meteo',    '⏳',   'word',  26),
  ('fr', 'excusez-moi',          'mi scusi',           null,                        null,   'chunk', 27),
  ('fr', 'fromage',              'formaggio',          null,                        '🧀',   'word',  28),
  ('fr', 'beau',                 'bello',              null,                        null,   'word',  29),
  ('fr', 'il y a',               'c''è / ci sono',     'per dire che qualcosa esiste',null,  'chunk', 30),
  ('fr', 'main',                 'mano',               null,                        '✋',   'word',  31),
  ('fr', 'aller',                'andare',             null,                        '🚶',   'word',  32),
  ('fr', 'ville',                'città',              null,                        '🏙️',  'word',  33),
  ('fr', 'je m''appelle',        'mi chiamo',          null,                        null,   'chunk', 34),
  ('fr', 'chat',                 'gatto',              null,                        '🐱',   'word',  35),
  ('fr', 'chaud',                'caldo',              null,                        '🥵',   'word',  36),
  ('fr', 'arbre',                'albero',             null,                        '🌳',   'word',  37),
  ('fr', 'combien ça coûte',     'quanto costa?',      null,                        null,   'chunk', 38),
  ('fr', 'argent',               'soldi',              null,                        '💰',   'word',  39),
  ('fr', 'dormir',               'dormire',            null,                        '😴',   'word',  40),
  ('fr', 'homme',                'uomo',               null,                        '👨',   'word',  41),
  ('fr', 'de rien',              'di niente',          null,                        null,   'chunk', 42),
  ('fr', 'clé',                  'chiave',             null,                        '🔑',   'word',  43),
  ('fr', 'bonne nuit',           'buonanotte',         null,                        null,   'chunk', 44),
  ('fr', 'où est',               'dov''è…?',           'per chiedere una direzione', null,   'chunk', 45),
  ('fr', 'poisson',              'pesce',              null,                        '🐟',   'word',  46),
  ('fr', 'acheter',              'comprare',           null,                        '🛒',   'word',  47),
  ('fr', 'soleil',               'sole',               null,                        '☀️',  'word',  48),
  ('fr', 'je ne comprends pas',  'non capisco',        null,                        null,   'chunk', 49),
  ('fr', 'cœur',                 'cuore',              null,                        '❤️',  'word',  50)
on conflict on constraint words_lang_text_gloss_unique do nothing;
