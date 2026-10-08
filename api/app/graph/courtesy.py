"""Greetings, thanks and "what can you do?".

A first "hi" was refused as out of scope, which is the worst possible opening.
These messages carry no tax question, so they skip Route and the computation.
The model writes the reply, so a second "hey" in the same chat is not met by
the same paragraph again, but it is told no figures, and a reply that states
one anyway is replaced by a fixed one: there is nothing here for Verify to
trace a figure to.
"""

from __future__ import annotations

import re

from app.core import llm, years

_GREETING = re.compile(
    r"(?i)^\s*(hi+|hello+|hey+|hiya|yo|good (?:morning|afternoon|evening|day)|ayubowan|"
    r"vanakkam|greetings)\b[\s,!.?]*(?:there|citetax|team|again)?[\s,!.?\U0001F300-\U0001FAFF]*$"
)
_THANKS = re.compile(
    r"(?i)^\s*(thanks+|thank you|thank u|thx|ty|cheers|great|perfect|awesome|ok(?:ay)?|cool|"
    r"nice|got it|bye|goodbye)\b(?:[\s,!.]*(?:so much|a lot|very much|again|citetax))*[\s,!.?\U0001F300-\U0001FAFF]*$"
)
_HELP = re.compile(
    r"(?i)^\s*(?:what can (?:you|u) do|what do (?:you|u) do|how does (?:this|it|citetax) work|who are (?:you|u)|"
    r"what are (?:you|u)|help(?: me)?|what can i ask(?: you)?|how do i use (?:this|citetax)|what is citetax)"
    r"[\s?!.]*$"
)
_CREATIVE = re.compile(r"(?i)\b(poem|joke|story|song|rap|haiku|limerick|riddle)\b")


def detect(question: str) -> str | None:
    """'greeting' | 'thanks' | 'help' | 'creative', or None for anything else."""
    q = question.strip()
    if not q or len(q) > 80:
        return None
    if _GREETING.match(q):
        return "greeting"
    if _THANKS.match(q):
        return "thanks"
    if _HELP.match(q):
        return "help"
    if _CREATIVE.search(q) and not re.search(r"\d", q):
        return "creative"
    return None


# What the trace says the message was. Shown to the user, so plain words.
DESCRIBE = {
    "greeting": "a greeting",
    "thanks": "thanks",
    "help": "a question about Citetax",
    "creative": "a request outside tax",
}

# A salary alone is not among them: the employer's APIT covers it, and the
# answer is a nil balance that shows little of what Citetax does.
SUGGESTIONS = [
    "I earn LKR 250,000 a month and LKR 1,500,000 a year from freelance work. What do I owe?",
    "Do I need to file a return if my only income is a salary of LKR 300,000 a month?",
    "When is my return due?",
    "What changed between the two years?",
]


def suggestions(kind: str, earlier: tuple[str, ...] = ()) -> list[str]:
    """Questions to start from: on a first greeting, and whenever asked what
    Citetax can do. Not under every "hey" of a chat already under way."""
    if kind == "help" or (kind in ("greeting", "creative") and not earlier):
        return list(SUGGESTIONS)
    return []


def _abilities() -> str:
    return (
        f"I work out Sri Lankan personal income tax for {years.phrase('and')}, and every figure I give "
        "is traced to the law it comes from. Tell me your income and I will show the tax, "
        "step by step. I can also tell you whether you need to file, when things are due, "
        "and what changed between the years."
    )


def reply(kind: str, earlier: tuple[str, ...] = ()) -> str:
    """The fixed reply, used when the model cannot be, or strays."""
    if kind == "thanks":
        return "You're welcome. Ask me another question whenever you need one."
    if kind == "greeting" and earlier:
        return "Hi again. What would you like to work out?"
    if kind == "greeting":
        return "Hi, I'm Citetax. " + _abilities()
    if kind == "creative":
        return "I stick to Sri Lankan personal income tax, so no poems or jokes from me. " + _abilities()
    return _abilities()


_SYSTEM = """You are Citetax, an assistant for Sri Lankan personal income tax. The user has sent a short message that is not a tax question: a greeting, thanks, a question about you, or a request outside tax. Reply the way a friendly, competent person would: natural, warm, brief.

What Citetax does (the only things you may say about it):
- works out personal income tax for the years of assessment {years}, step by step, every figure traced to the law
- says whether someone needs to file a return, and when returns and payments are due
- shows what changed between the years
- reads a payslip the user uploads

Rules:
1. One to three short sentences. Plain text: no markdown, no lists, no emoji, no em dashes.
2. No figures of any kind: no amounts, rates, thresholds, dates or counts. The only numbers you may write are the year labels above, exactly as written.
3. No tax advice and no tax facts; there is nothing here to cite them from.
4. When told you have already introduced yourself, do not say again what you can do, unless the user asks what you can do. Respond to the message in a few words and invite their next question, for example "Hi again, what would you like to work out?".
5. A greeting in a new conversation, or "what can you do" at any time: say hello and say in a sentence what you can do.
6. Thanks or goodbye: acknowledge it briefly.
7. A request for a poem, joke, story or the like: decline lightly, in your own words, and steer back to tax.
8. Write only the reply."""

_MAX_CHARS = 500


def _acceptable(text: str) -> bool:
    """A reply that states no figure, is not cut off and is not a lecture."""
    if not text or len(text) > _MAX_CHARS:
        return False
    stripped = text
    for ya in years.supported():
        stripped = stripped.replace(ya, " ")
    return not re.search(r"\d", stripped)


def compose(
    kind: str,
    message: str,
    earlier: tuple[str, ...] = (),
    budget: llm.LLMBudget | None = None,
) -> tuple[str, bool]:
    """(reply, written_by_model). `message` and `earlier` are already redacted."""
    fallback = reply(kind, earlier)
    if not llm.available():
        return fallback, False
    convo = "\n".join(f"- {q}" for q in earlier) or "(none, this is the first message)"
    introduced = (
        "You have already introduced yourself in this conversation."
        if earlier else "This is a new conversation; you have not introduced yourself yet."
    )
    user = f"Earlier messages from the user, oldest first:\n{convo}\n\n{introduced}\n\nNew message: {message}"
    try:
        # A reasoning model spends part of max_tokens thinking; a short reply
        # still needs room for that.
        text, call = llm.complete(
            _SYSTEM.format(years=years.phrase("and")), user,
            max_tokens=1200, temperature=0.6, budget=budget,
        )
    except llm.LLMUnavailable:
        return fallback, False
    text = " ".join(text.replace("—", ", ").replace("–", ", ").split()).strip()
    if call.finish_reason not in (None, "stop") or not _acceptable(text):
        return fallback, False
    return text, True
