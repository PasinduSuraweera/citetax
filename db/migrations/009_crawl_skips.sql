-- Citetax migration 009: what a crawl chose not to fetch, and why.
--
-- {"robots": [urls], "gone": [urls], "listing": [urls]}. A page robots.txt
-- disallows is recorded, not silently dropped (#54). Additive only.

alter table crawl_run add column if not exists skipped_json jsonb;
