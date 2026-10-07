"""Tax-saving scenarios. Every expectation is worked by hand from the real
bands (6/18/24/30/36%, relief 1,800,000) and checked against the engine."""

from __future__ import annotations

from decimal import Decimal

from app.compute.engine import compute
from app.compute.savings import analyse
from app.compute.types import TaxFacts
from tests.test_engine import _rules

D = Decimal


def _facts(income: str, **kw) -> TaxFacts:
    # A stated nil APIT keeps the whole tax as the balance, which is what the
    # arithmetic below is worked from. The assumed APIT has its own test.
    kw.setdefault("apit_withheld", D(0))
    return TaxFacts(ya="2026/2027", employment_income=D(income), **kw)


def _run(income: str, rules=None, **kw):
    rules = rules or _rules()
    facts = _facts(income, **kw)
    base = compute(facts, rules)
    return facts, rules, base, analyse(facts, rules, base)


def test_no_tax_means_no_advice():
    # 1,500,000 less EPF 120,000 is inside the 1,800,000 relief.
    assert _run("1500000")[3] is None


def test_top_band_lever_clears_the_slice_above_the_band_edge():
    # 6,000,000: EPF 480,000, relief 1,800,000 -> taxable 3,720,000.
    # 1,220,000 of it is in the 36% band, above the 2,500,000 edge.
    facts, rules, base, sv = _run("6000000")
    assert base.taxable_income == D("3720000.00")
    edge = sv.levers[0]
    assert edge.kind == "band_edge"
    assert edge.extra_deduction == D("1220000.00")
    # 1,220,000 at 36% = 439,200
    assert edge.tax_saved == D("439200.00")
    assert sv.marginal_rate == D("0.36")


def test_saving_is_the_difference_of_two_engine_runs():
    facts, rules, base, sv = _run("6000000")
    for lever in sv.levers:
        again = compute(
            facts.model_copy(update={"qualifying_payments": lever.extra_deduction}), rules
        )
        assert lever.tax_saved == base.balance_payable - again.balance_payable
        assert lever.new_balance == again.balance_payable


def test_scenarios_are_ordered_and_distinct():
    _, _, _, sv = _run("6000000")
    extras = [lv.extra_deduction for lv in sv.levers]
    assert extras[0] == D("1220000.00")                 # the band edge first
    assert extras[1:] == sorted(extras[1:])
    assert len(extras) == len(set(extras))


def test_scenario_never_exceeds_taxable_income():
    # 2,300,000: EPF 184,000, relief 1,800,000 -> taxable 316,000 at 6%.
    _, _, _, sv = _run("2300000")
    assert all(lv.extra_deduction <= D("316000") for lv in sv.levers)
    # 100,000 at 6% = 6,000
    assert sv.levers[0].tax_saved == D("6000.00")


def test_cap_limits_the_scenarios():
    rules = _rules(**{"deduction.qualifying": {"annual_cap": "150000"}})
    _, _, _, sv = _run("6000000", rules)
    assert all(lv.extra_deduction <= D("150000") for lv in sv.levers)


def test_no_headroom_means_no_advice():
    rules = _rules(**{"deduction.qualifying": {"annual_cap": "100000"}})
    assert _run("6000000", rules, qualifying_payments=D("100000"))[3] is None


def test_levers_cite_the_qualifying_rule():
    rules = _rules()
    _, _, _, sv = _run("6000000", rules)
    rv = rules["deduction.qualifying"]
    assert all(lv.rule_version_id == rv.id for lv in sv.levers)
    assert all(lv.citation_label == rv.citation_label for lv in sv.levers)


def test_serialises_money_as_strings():
    body = _run("6000000")[3].to_json()
    # Tax on 3,720,000 taxable: 420,000 + 1,220,000 at 36% = 859,200.
    assert body["baseline_balance"] == "859200.00"
    assert isinstance(body["levers"][0]["tax_saved"], str)


def test_with_apit_assumed_a_saving_comes_back_as_a_refund():
    """The employer deducts APIT on the salary whatever the employee later
    claims, so a bigger deduction is a refund of APIT, not a smaller one."""
    facts = TaxFacts(ya="2026/2027", employment_income=D("6000000"))
    rules = _rules()
    base = compute(facts, rules)
    assert base.balance_payable == 0
    sv = analyse(facts, rules, base)
    edge = sv.levers[0]
    assert edge.tax_saved == D("439200.00") and edge.new_balance == -edge.tax_saved
