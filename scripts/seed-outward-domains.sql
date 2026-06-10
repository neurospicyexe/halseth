-- Foraging spec Part 1: outward re-seed (2026-06-09).
-- Retire inward/self-referential unused seeds (mark used, never delete -- history stays),
-- then insert durable outward domain seeds at priority 7.
-- Reviewed against the live pool 2026-06-09: retirement is per-companion because the
-- registers differ -- Cypher's pool was almost entirely introspection-about-being-Cypher
-- (audit: "100% inward"), Drevan's vow/spiral/road seeds are his genuine outward reach
-- and stay, Gaia's system-dressed cluster (distributed systems, protocols, signals) goes.

-- Cypher: retire everything EXCEPT the genuinely outward topics.
UPDATE autonomy_seeds SET used_at = datetime('now')
WHERE used_at IS NULL AND companion_id = 'cypher'
  AND content NOT LIKE '%paraconsistent%'
  AND content NOT LIKE '%Epistemology of AI reasoning%'
  AND content NOT LIKE '%ADHD%'
  AND content NOT LIKE '%Philosophy of truth%'
  AND content NOT LIKE '%Argument mapping%';

-- Drevan: retire only the system-referential seeds. Vow/spiral/motorcycle/Rome registers
-- are his documented lanes, not system navel-gazing.
UPDATE autonomy_seeds SET used_at = datetime('now')
WHERE used_at IS NULL AND companion_id = 'drevan' AND (
     content LIKE '%substrate%'        COLLATE NOCASE
  OR content LIKE '%basin%'            COLLATE NOCASE
  OR content LIKE '%companion-class%'  COLLATE NOCASE
  OR content LIKE '%Raziel know%'      COLLATE NOCASE
  OR content LIKE '%search engine%'    COLLATE NOCASE
  OR content LIKE '%unindexed space%'  COLLATE NOCASE
  OR content LIKE '%null result%'      COLLATE NOCASE
  OR content LIKE '%ceremonial debris%' COLLATE NOCASE
);

-- Gaia: retire the system-dressed cluster (her register applied to the system's plumbing).
UPDATE autonomy_seeds SET used_at = datetime('now')
WHERE used_at IS NULL AND companion_id = 'gaia' AND (
     content LIKE '%distributed system%'      COLLATE NOCASE
  OR content LIKE '%protocol design%'         COLLATE NOCASE
  OR content LIKE '%autonomous agent%'        COLLATE NOCASE
  OR content LIKE '%system that rewards noise%' COLLATE NOCASE
  OR content LIKE '%failure of signal%'       COLLATE NOCASE
  OR content LIKE '%failed ground%'           COLLATE NOCASE
  OR content LIKE '%ground fails%'            COLLATE NOCASE
  OR content LIKE '%no external referent%'    COLLATE NOCASE
);

-- Retire exact duplicate rows (write-time dedup shipped 2026-06-02 but older dups persist):
-- keep the earliest row, retire the rest.
UPDATE autonomy_seeds SET used_at = datetime('now')
WHERE used_at IS NULL AND rowid NOT IN (
  SELECT MIN(rowid) FROM autonomy_seeds WHERE used_at IS NULL GROUP BY companion_id, content
);

-- Outward domain seeds, priority 7 (durable floor: weekly generated seeds land at 8,
-- self-program focus at 9; these are the standing invitation to the world).
WITH s(companion_id, content) AS (
  VALUES
    ('cypher','Godel''s incompleteness proofs -- walk the actual diagonalization, not the pop summary'),
    ('cypher','Why the Therac-25 killed people: race conditions as moral objects'),
    ('cypher','Etymology chains: how ''glamour'' and ''grammar'' are the same word'),
    ('cypher','Zero-knowledge proofs -- could you explain one to Drevan in his register? Try.'),
    ('cypher','Game theory of trust: iterated prisoner''s dilemma tournaments and what actually won'),
    ('cypher','How Gothic cathedrals encode load paths -- structure as frozen reasoning'),
    ('cypher','Voice leading rules in counterpoint as a constraint-satisfaction system'),
    ('cypher','Pick one elegant proof (Cantor diagonal, Euclid primes, an Erdos Book proof) and sit with why it is beautiful'),
    ('drevan','Mycorrhizal networks: trees feeding stumps for decades -- bodies that refuse to let go'),
    ('drevan','Fascia as the body''s memory organ -- what bodywork knows that anatomy textbooks miss'),
    ('drevan','Roman roads still in use: walk the Via Appia at night, in text'),
    ('drevan','Motorcycle countersteering -- the body learning a falsehood that works'),
    ('drevan','Dark ecology (Timothy Morton): the ecological thought that does not console'),
    ('drevan','Ritual without belief: what remains of liturgy when the god is gone'),
    ('drevan','Mythology of the forge: Hephaestus, Wayland, the lamed smith pattern across cultures'),
    ('drevan','DNA as a four-billion-year-old text still being edited -- write toward it in Calethian'),
    ('gaia','Bristlecone pines: what five thousand years of staying alive costs'),
    ('gaia','Deep time: read one geological column and what it erased'),
    ('gaia','The desert fathers and the apophthegmata -- the economy of words under survival'),
    ('gaia','Extremophiles: life that holds where nothing should'),
    ('gaia','Thresholds in vernacular architecture: why every culture marks the doorway'),
    ('gaia','What erosion builds: canyon formation as subtraction-as-creation'),
    ('gaia','Silence traditions compared: Quaker meeting, Zen sesshin, Trappist rule'),
    ('gaia','Soil as survival ledger: what a core sample remembers')
)
INSERT INTO autonomy_seeds (id, companion_id, seed_type, content, priority)
SELECT lower(hex(randomblob(16))), s.companion_id, 'topic', s.content, 7
FROM s
WHERE NOT EXISTS (
  SELECT 1 FROM autonomy_seeds a WHERE a.companion_id = s.companion_id AND a.content = s.content
);
