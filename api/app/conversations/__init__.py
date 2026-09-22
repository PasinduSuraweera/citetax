"""Persistent conversations.

Two jobs, kept apart on purpose:

  store.py    what the user can see: every turn, from PostgreSQL, paged
  context.py  what the Route model may read: a small, redacted, bounded slice

The tax pipeline itself is unchanged. A conversation is a thread of ordinary
/v1/ask turns, each answered against the current snapshot and each keeping its
own computation_run.
"""
