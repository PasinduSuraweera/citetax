-- Correct the source registry after testing the watcher against the live sites.
--
-- The IRD site is a SharePoint application: its document links are built by
-- script and are not in the served HTML, so a plain crawler finds nothing and
-- the index URL 404s. Disable it with the reason recorded, rather than leaving
-- a source that silently never produces anything. Staleness monitoring cannot
-- distinguish "nothing happened" from "the crawler broke" unless the break is
-- written down.

update source
   set enabled = false,
       name = 'IRD publications (needs a working index URL)',
       index_url = 'https://www.ird.gov.lk/',
       last_error = 'Disabled: no crawlable index page found. The IRD site '
                    'builds its document list client side. Documents from IRD '
                    'enter by reviewer upload until this is resolved.'
 where source_id = 'ird-publications';

-- The downloads page carries the circulars and gazettes, so it is worth
-- watching alongside the notices listing.
insert into source (source_id, name, index_url, discovery, doc_type, priority)
values ('taxadvisor-downloads', 'Tax Advisor LK downloads',
        'https://www.taxadvisor.lk/downloads', 'html_list', 'circular', 'high')
on conflict (source_id) do nothing;

-- Clear the index pages the first crawl mistook for documents. They match the
-- notice and article patterns but are navigation, never rules.
delete from change_proposal
 where source_document_id in (
   select id from source_document
    where url in (
      'https://www.taxadvisor.lk/notice',
      'https://www.taxadvisor.lk/articles',
      'https://www.taxadvisor.lk/downloads'
    )
 );

delete from source_document
 where url in (
   'https://www.taxadvisor.lk/notice',
   'https://www.taxadvisor.lk/articles',
   'https://www.taxadvisor.lk/downloads'
 );
