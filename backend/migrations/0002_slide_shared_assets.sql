-- Rendered decks' offline-assets/ (MathJax, KaTeX, fonts) are stored once per worker asset set under
-- slides/_shared/<hash>/ instead of per version. NULL means the version's own output holds them.
ALTER TABLE slide_versions ADD COLUMN shared_prefix text CHECK (shared_prefix ~ '^slides/_shared/[0-9a-f]{32}/$');
