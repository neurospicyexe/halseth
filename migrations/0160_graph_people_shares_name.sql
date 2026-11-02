-- 0160_graph_people_shares_name.sql -- a person whose name is also a character's (Raziel, 2026-11-01)
--
-- WHY. Many of Raziel's system and Blue's system carry names that are also characters (Blue's Hector
-- Barbossa introject, and Pirates of the Caribbean is on tonight). The people lane (rebuild lane l)
-- matched an entry's LABEL bare, so listing "Barbossa" would link every line about the film to the
-- person. Suppressing by context (rows written during the watchalong, rows naming the title) was
-- rejected: the person is most likely to front DURING the film, so that rule would drop exactly the
-- true links, and it is the graph guessing, which 0149 forbids.
--
-- RULE. shares_name_with set (free text: the work(s) the name also belongs to) = the label is NOT
-- matched bare. Only the entry's other spellings link ("Blue's Barbossa", "Barbossa (Blue)"), which
-- are exact, case-sensitive and word-bounded as before. The label stays as the readable name on the
-- map. NULL = unchanged behaviour (label matched). Applied in people.ts spellingsOf, so the matcher,
-- the ambiguity check and Hearth all agree.

ALTER TABLE graph_people ADD COLUMN shares_name_with TEXT;
