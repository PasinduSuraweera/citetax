"""Document titles: the page's own name, never the site's, a slug or script."""

from app.corpus.titles import clean_title, document_title

TA = "https://www.taxadvisor.lk/news/x"
IRD = "https://www.ird.gov.lk/en/Downloads/Tools.aspx?menuid=1605"


def test_site_name_is_dropped_whichever_part_is_longer():
    assert clean_title("Tax Advisor - Instant Tax Solutions :: - Eight Key Changes in the Revised Quarterly Tax Circular", TA) \
        == "Eight Key Changes in the Revised Quarterly Tax Circular"
    assert clean_title("Tax Advisor - Instant Tax Solutions :: - Downloads", TA) == "Downloads"


def test_a_home_page_keeps_the_site_name():
    assert clean_title("Tax Advisor - Instant Tax Solutions ::", TA) == "Tax Advisor - Instant Tax Solutions"


def test_script_after_the_title_is_cut():
    raw = "Tax Advisor - Instant Tax Solutions :: - New IRD Forms for VAT Registration Confirmation window.dataLayer = window.dataL"
    assert clean_title(raw, TA) == "New IRD Forms for VAT Registration Confirmation"


def test_dashes_inside_a_title_are_kept():
    assert clean_title("APIT – Table 8 explained | Tax Advisor", TA) == "APIT – Table 8 explained"


def test_slugs_and_markers_are_not_titles():
    assert clean_title("Tools.aspx?menuid=1605", IRD) is None
    assert clean_title("[page 1]", IRD) is None


def test_html_title_wins_over_body_text():
    body = b"<html><head><title>Tax Advisor :: - Quarterly Tax Circular Revised Again</title></head><body>Menu</body></html>"
    assert document_title(body, "Menu\nmore", TA, is_html=True) == "Quarterly Tax Circular Revised Again"


def test_og_title_wins_over_title():
    body = b'<meta property="og:title" content="Five Key Changes"><title>Site</title>'
    assert document_title(body, "", TA, is_html=True) == "Five Key Changes"


def test_nothing_usable_names_the_host():
    assert document_title(None, "", IRD, is_html=False) == "Page on ird.gov.lk"
