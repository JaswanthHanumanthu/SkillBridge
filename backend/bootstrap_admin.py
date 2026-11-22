"""Explicit, idempotent provisioning for the trusted local platform admin.

Run from the project root with ``python -m backend.bootstrap_admin`` after
setting ADMIN_USERNAME and ADMIN_PASSWORD in the root .env file.
"""
import sys

from psycopg2 import errors as pg_errors

from backend.config import Config
from backend.db import close_db_pool, get_db
from backend.utils import hash_password


class AdminBootstrapConflict(RuntimeError):
    """Raised when the configured username belongs to a non-admin account."""


def provision_admin():
    username = Config.ADMIN_USERNAME
    password = Config.ADMIN_PASSWORD

    if not username or not password:
        raise RuntimeError(
            "Admin bootstrap is not configured. Set ADMIN_USERNAME and "
            "ADMIN_PASSWORD in the project-root .env file before running "
            "python -m backend.bootstrap_admin."
        )
    if len(username) < 3 or len(username) > 50:
        raise RuntimeError("ADMIN_USERNAME must contain between 3 and 50 characters.")
    if len(password) < 6:
        raise RuntimeError("ADMIN_PASSWORD must contain at least 6 characters.")

    # Keep the project's existing username normalization convention.
    username = username.lower()

    try:
        with get_db() as (_conn, cur):
            # Serialize bootstrap attempts for this configured name, including
            # the absent-row case that SELECT ... FOR UPDATE cannot lock.
            cur.execute(
                "SELECT pg_advisory_xact_lock(%s, hashtext(%s))",
                (0x534B42, username),
            )
            cur.execute(
                "SELECT id, role FROM accounts WHERE LOWER(username)=%s FOR UPDATE",
                (username,),
            )
            existing = cur.fetchone()
            if existing:
                if existing["role"] != "developer":
                    raise AdminBootstrapConflict(
                        "Admin bootstrap conflict: the configured administrator "
                        "username is already assigned to a non-administrator "
                        "account. No account was changed. Choose a different "
                        "ADMIN_USERNAME."
                    )
                # Never reset an existing administrator's password or account.
                return {"created": False, "account_id": existing["id"]}

            password_hash = hash_password(password)
            cur.execute(
                """
                INSERT INTO accounts (username, password_hash, role)
                VALUES (%s, %s, 'developer')
                RETURNING id
                """,
                (username, password_hash),
            )
            return {"created": True, "account_id": cur.fetchone()["id"]}
    except pg_errors.UniqueViolation as exc:
        # A concurrent signup may have claimed the username while bootstrap
        # was preparing it. Report a safe configuration conflict, not SQL.
        raise AdminBootstrapConflict(
            "Admin bootstrap conflict: the configured username was claimed by "
            "another account during setup. No existing account was promoted."
        ) from exc


def main():
    try:
        result = provision_admin()
    except (RuntimeError, AdminBootstrapConflict) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    finally:
        close_db_pool()

    if result["created"]:
        print("Platform administrator account provisioned.")
    else:
        print("Platform administrator already exists; its password was not changed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
