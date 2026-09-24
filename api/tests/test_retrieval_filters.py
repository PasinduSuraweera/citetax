"""Retrieval filters that need no database: template lines and unreadable text."""

from app.retrieval.indexer import strip_boilerplate
from app.retrieval.search import _readable


def test_template_lines_are_removed_and_content_kept():
    raw = "Home\nTax Academy\nAPIT is deducted monthly.\nCopyright 2017-2026\nIt is credited."
    boiler = {"Home", "Tax Academy", "Copyright 2017-2026"}
    assert strip_boilerplate(raw, boiler) == "APIT is deducted monthly.\nIt is credited."


def test_no_template_leaves_text_alone():
    assert strip_boilerplate("a\nb", set()) == "a\nb"


def test_letter_spaced_pdf_text_is_unreadable():
    assert not _readable("N O T I C E T O T A X P A Y E R S 1 . V A T P a y m e n t s d u e")


def test_listing_pages_are_unreadable():
    assert not _readable("Budget 2026 ... Read More Personal Relief ... Read More")


def test_ordinary_prose_is_readable():
    assert _readable("An individual deriving only employment income subject to APIT is not "
                     "required to make quarterly instalment payments.")
