"""Signed cookie session middleware compatible with the existing browser cookie name."""
import hashlib
import json
from itsdangerous import BadSignature, URLSafeTimedSerializer
from starlette.middleware.base import BaseHTTPMiddleware


class _JSONSerializer:
    def dumps(self, value):
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    def loads(self, value):
        return json.loads(value)


class SignedSessionMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, secret_key: str, cookie_name="session", max_age=31 * 24 * 60 * 60, https_only=False):
        super().__init__(app)
        self.cookie_name, self.max_age, self.https_only = cookie_name, max_age, https_only
        # Retain the previous backend's cookie salt and signer settings so existing
        # JSON-valued browser sessions remain valid during the framework migration.
        self.serializer = URLSafeTimedSerializer(
            secret_key, salt="cookie-session", serializer=_JSONSerializer(),
            signer_kwargs={"key_derivation": "hmac", "digest_method": hashlib.sha1},
        )

    async def dispatch(self, request, call_next):
        cookie = request.cookies.get(self.cookie_name)
        try:
            data = self.serializer.loads(cookie, max_age=self.max_age) if cookie else {}
            if not isinstance(data, dict): data = {}
        except BadSignature:
            data = {}
        request.scope["session"] = data
        original = dict(data)
        response = await call_next(request)
        changed = data != original
        if changed:
            if data:
                value = self.serializer.dumps(data)
                response.set_cookie(self.cookie_name, value, max_age=self.max_age,
                                    httponly=True, secure=self.https_only, samesite="lax", path="/")
            else:
                response.delete_cookie(self.cookie_name, path="/", httponly=True,
                                       secure=self.https_only, samesite="lax")
        return response
