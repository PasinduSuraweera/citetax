"""What the watcher counts as a change, and what the extractor drops."""

from __future__ import annotations

from app.corpus.extractor import ProposedChange, _why_not
from app.corpus.pdf import content_fingerprint, html_to_text
from app.corpus.watcher import extract_links

ARTICLE = """<html><body><nav><a href="/">Home</a><a href="/notice">Notices</a></nav>
<article><h1>APIT update</h1><p>The deduction applies from 1 April 2026.</p></article>
<div id="noticeList">{sidebar}</div>
<input type="hidden" name="__VIEWSTATE" value="{state}"></body></html>"""


def _fp(html: str) -> tuple[str, float]:
    body = html.encode()
    return content_fingerprint(body, html_to_text(body), is_html=True)


def test_a_new_sidebar_post_or_view_state_is_not_a_revision():
    a = _fp(ARTICLE.format(sidebar='<a href="/notice/1">Old post</a>', state="abc"))
    b = _fp(ARTICLE.format(sidebar='<a href="/notice/2">New post</a><a href="/notice/1">Old post</a>', state="xyz"))
    assert a[0] == b[0]


def test_a_changed_sentence_is_a_revision():
    a = _fp(ARTICLE.format(sidebar="", state=""))
    b = _fp(ARTICLE.replace("1 April 2026", "1 May 2026").format(sidebar="", state=""))
    assert a[0] != b[0]


def test_a_page_of_links_is_a_listing():
    links = "".join(f'<li><a href="/notice/{i}">Notice number {i}</a></li>' for i in range(30))
    _, share = _fp(f"<html><body><ul>{links}</ul></body></html>")
    assert share >= 0.9
    _, article_share = _fp(ARTICLE.format(sidebar="", state=""))
    assert article_share < 0.5


def test_paginated_listings_are_not_documents():
    html = '<a href="/articles/index/page/4">4</a><a href="/article/abc">An article</a>'
    urls = [d.url for d in extract_links(html, "https://www.taxadvisor.lk/articles")]
    assert urls == ["https://www.taxadvisor.lk/article/abc"]


def _change(**kw) -> ProposedChange:
    base = dict(rule_key="deadline.return_filing", operation="amend", value_json={},
                quoted_text="q", confidence=0.9, rationale="r")
    return ProposedChange(**{**base, **kw})


def test_figures_from_before_the_supported_years_are_dropped():
    # These return before any query runs, so no connection is needed.
    old = _change(effective_from="2022-04-01")
    assert _why_not(None, "d", old, {}) == "before the supported years"
    old_due = _change(value_json={"due": "2020-11-30"})
    assert _why_not(None, "d", old_due, old_due.value_json) == "before the supported years"
    ended = _change(effective_to="2024-03-31")
    assert _why_not(None, "d", ended, {}) == "before the supported years"
