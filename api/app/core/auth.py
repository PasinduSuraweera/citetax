"""Authentication and roles.

Identity comes from Google through NextAuth in the web app, which signs a JWT
with a shared secret. This module verifies that token and maps it to an
app_user row carrying the role.

Roles exist because dual control needs two distinct named humans (spec section
5.1 E). An env allowlist cannot express "approved by A, counter-approved by B".
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Annotated

import jwt
from fastapi import Depends, Header, HTTPException
from sqlalchemy import text

from app.core.config import get_settings
from app.db.session import db_conn

logger = logging.getLogger(__name__)

# Ordered least to most privileged. A role satisfies a requirement if it sits
# at or above it, except the read-only auditor which is deliberately separate.
ROLE_ORDER = ["free", "individual", "practice", "reviewer", "approver", "admin"]


@dataclass(frozen=True)
class User:
    id: str
    email: str
    name: str | None
    role: str
    # What the account pays for (app.core.plans), separate from the role.
    plan: str = "free"

    @property
    def is_reviewer(self) -> bool:
        return self.role in ("reviewer", "approver", "admin")

    @property
    def can_approve(self) -> bool:
        """Second signature on rate, band and threshold changes."""
        return self.role in ("approver", "admin")

    def at_least(self, role: str) -> bool:
        if self.role == "auditor":
            return role in ("free", "individual", "auditor")
        try:
            return ROLE_ORDER.index(self.role) >= ROLE_ORDER.index(role)
        except ValueError:
            return False


def _decode(token: str) -> dict:
    settings = get_settings()
    if not settings.auth_secret:
        raise HTTPException(500, "AUTH_SECRET is not configured on the API")
    try:
        return jwt.decode(
            token,
            settings.auth_secret,
            algorithms=["HS256"],
            options={"require": ["exp"]},
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Session expired, sign in again") from None
    except jwt.InvalidTokenError as exc:
        raise HTTPException(401, "Invalid session token") from exc


def _upsert_user(email: str, name: str | None, picture: str | None) -> User:
    """First sign-in creates the account. The role is never taken from the
    token: a client could claim any role it liked. It is read from the row."""
    settings = get_settings()
    # Someone has to be able to reach the admin panel before any account
    # exists. Listed emails are promoted on sign-in; everyone else starts as an
    # ordinary individual and is promoted from inside the panel.
    is_bootstrap = email.lower() in settings.bootstrap_admin_list
    initial_role = "admin" if is_bootstrap else "individual"

    with db_conn() as conn:
        row = conn.execute(
            text(
                "insert into app_user (email, name, picture, role, last_seen_at) "
                "values (:e, :n, :p, :role, now()) "
                "on conflict (email) do update set "
                "  name = coalesce(excluded.name, app_user.name), "
                "  picture = coalesce(excluded.picture, app_user.picture), "
                "  role = case when :bootstrap then 'admin' else app_user.role end, "
                "  last_seen_at = now() "
                "returning id, email, name, role, plan"
            ),
            {
                "e": email.lower(),
                "n": name,
                "p": picture,
                "role": initial_role,
                "bootstrap": is_bootstrap,
            },
        ).mappings().one()
        conn.commit()
    return User(
        id=str(row["id"]), email=row["email"], name=row["name"], role=row["role"],
        plan=row["plan"],
    )


def current_user(
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    """Required authentication. Raises 401 when absent or invalid."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Sign in to continue")
    claims = _decode(authorization.split(" ", 1)[1])
    email = claims.get("email")
    if not email:
        raise HTTPException(401, "Token carries no email claim")
    return _upsert_user(email, claims.get("name"), claims.get("picture"))


def optional_user(
    authorization: Annotated[str | None, Header()] = None,
) -> User | None:
    """Anonymous access is a supported tier (spec section 1.3), so the public
    answer path accepts a missing token rather than refusing."""
    if not authorization:
        return None
    try:
        return current_user(authorization)
    except HTTPException:
        return None


def require_role(role: str):
    """Dependency factory: `Depends(require_role("reviewer"))`."""

    def dependency(user: Annotated[User, Depends(current_user)]) -> User:
        if not user.at_least(role):
            raise HTTPException(
                403,
                f"This action needs the {role} role. Your account is {user.role}.",
            )
        return user

    return dependency


ReviewerDep = Annotated[User, Depends(require_role("reviewer"))]
ApproverDep = Annotated[User, Depends(require_role("approver"))]
AdminDep = Annotated[User, Depends(require_role("admin"))]
CurrentUserDep = Annotated[User, Depends(current_user)]
OptionalUserDep = Annotated[User | None, Depends(optional_user)]
