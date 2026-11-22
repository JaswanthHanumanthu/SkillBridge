"""FastAPI router adapter for the existing route business logic.

This keeps route URLs and response contracts stable while request/session handling
runs on ASGI. It is an internal adapter and adds no runtime Flask dependency.
"""
from contextvars import ContextVar
from functools import wraps
import inspect
import json
import logging
import re
from pathlib import Path
from typing import Any

_MAX_MULTIPART_FILE_BYTES = 16 * 1024 * 1024

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import TypeAdapter, ValidationError
from starlette.concurrency import run_in_threadpool

_request_context: ContextVar["RequestContext | None"] = ContextVar("request_context", default=None)
_json_object = TypeAdapter(dict[str, Any])


class QueryArgs:
    def __init__(self, request: Request): self._query = request.query_params
    def get(self, key, default=None, type=None):
        value = self._query.get(key, default)
        if type is not None and value is not None:
            try: return type(value)
            except (TypeError, ValueError): return default
        return value


class UploadedFile:
    def __init__(self, filename: str, content: bytes, content_type: str = "", size: int | None = None):
        self.filename, self._content = filename, content
        self.size, self.content_type = size if size is not None else len(content), content_type
    def read(self): return self._content
    def save(self, path): Path(path).write_bytes(self._content)


class RequestContext:
    def __init__(self, request: Request, json_body=None, form=None, files=None):
        self.raw = request
        self.json_body = json_body
        self.form = form or {}
        self.files = files or {}
        self.args = QueryArgs(request)
        self.method = request.method
    def get_json(self): return self.json_body


async def get_request_context(request: Request) -> RequestContext:
    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        if request.url.path == "/api/chatbot/ask" and request.method == "POST":
            content_length = request.headers.get("content-length")
            if content_length:
                try:
                    if int(content_length) > 8192:
                        raise HTTPException(status_code=413, detail="BridgeMate request is too large.")
                except ValueError as exc:
                    raise HTTPException(status_code=400, detail="Invalid Content-Length header.") from exc
        try:
            raw_body = await request.body()
            if request.url.path == "/api/chatbot/ask" and len(raw_body) > 8192:
                raise HTTPException(status_code=413, detail="BridgeMate request is too large.")
            raw = json.loads(raw_body)
            return RequestContext(request, json_body=_json_object.validate_python(raw))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return RequestContext(request, json_body=None)
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail="Request body must be a JSON object.") from exc
    if "multipart/form-data" in content_type or "application/x-www-form-urlencoded" in content_type:
        form = await request.form()
        values, files = {}, {}
        for key, value in form.multi_items():
            if hasattr(value, "filename"):
                upload_size = getattr(value, "size", None)
                content = await value.read(_MAX_MULTIPART_FILE_BYTES + 1)
                files[key] = UploadedFile(value.filename or "", content, getattr(value, "content_type", "") or "", upload_size)
            else: values[key] = value
        return RequestContext(request, form=values, files=files)
    return RequestContext(request)


class RequestProxy:
    def __getattr__(self, name):
        ctx = _request_context.get()
        if ctx is None: raise RuntimeError("Request context is only available during an API request")
        return getattr(ctx, name)


class SessionProxy:
    def _session(self):
        ctx = _request_context.get()
        if ctx is None: raise RuntimeError("Session is only available during an API request")
        return ctx.raw.scope.setdefault("session", {})
    def __getitem__(self, key): return self._session()[key]
    def __setitem__(self, key, value): self._session()[key] = value
    def __contains__(self, key): return key in self._session()
    def get(self, key, default=None): return self._session().get(key, default)
    def clear(self): self._session().clear()


class CurrentAppProxy:
    logger = logging.getLogger("skillbridge.api")


request = RequestProxy()
session = SessionProxy()
current_app = CurrentAppProxy()


def jsonify(payload): return payload


def abort(status_code: int): raise HTTPException(status_code=status_code)


def send_from_directory(directory, filename):
    root = Path(directory).resolve()
    path = (root / filename).resolve()
    if not path.is_relative_to(root) or not path.is_file(): raise HTTPException(status_code=404)
    return FileResponse(path)


def login_required(func):
    @wraps(func)
    def wrapped(*args, **kwargs):
        if "account_id" not in session: return jsonify({"error": "Authentication required. Please log in."}), 401
        return func(*args, **kwargs)
    return wrapped


def role_required(*allowed_roles):
    def decorate(func):
        @wraps(func)
        def wrapped(*args, **kwargs):
            if "account_id" not in session: return jsonify({"error": "Authentication required. Please log in."}), 401
            role = session.get("role")
            if role not in allowed_roles:
                return jsonify({"error": f"Access denied. Requires one of roles: {', '.join(allowed_roles)}. Your role is '{role}'."}), 403
            return func(*args, **kwargs)
        return wrapped
    return decorate


class Blueprint(APIRouter):
    """APIRouter with the existing `route` declaration style during migration."""
    def __init__(self, name, import_name=None, url_prefix=""):
        super().__init__(prefix=url_prefix)
        self.name = name

    def route(self, path, methods=None):
        methods = methods or ["GET"]
        fast_path = re.sub(r"<int:([A-Za-z_][A-Za-z0-9_]*)>", r"{\1}", path)
        fast_path = re.sub(r"<path:([A-Za-z_][A-Za-z0-9_]*)>", r"{\1:path}", fast_path)
        def register(func):
            original_sig = inspect.signature(func)
            route_names = set(re.findall(r"\{([A-Za-z_][A-Za-z0-9_]*)(?::path)?\}", fast_path))
            params = [inspect.Parameter("ctx", inspect.Parameter.POSITIONAL_OR_KEYWORD, default=Depends(get_request_context), annotation=RequestContext)]
            for name, parameter in original_sig.parameters.items():
                if name in route_names: params.append(parameter.replace(kind=inspect.Parameter.KEYWORD_ONLY))

            async def endpoint(ctx: RequestContext = Depends(get_request_context), **path_values):
                token = _request_context.set(ctx)
                try:
                    if inspect.iscoroutinefunction(func): result = await func(**path_values)
                    else: result = await run_in_threadpool(func, **path_values)
                    status_code = 200
                    if isinstance(result, tuple) and len(result) == 2 and isinstance(result[1], int):
                        result, status_code = result
                    if isinstance(result, FileResponse): return result
                    from fastapi.responses import JSONResponse
                    return JSONResponse(content=result, status_code=status_code)
                finally:
                    _request_context.reset(token)

            endpoint.__name__ = func.__name__
            endpoint.__doc__ = func.__doc__
            endpoint.__signature__ = inspect.Signature(params)
            # An empty Flask-style suffix maps to the prefix itself (for example,
            # `/api/jobs`). Keep the slash form as an alias for existing clients.
            route_paths = (fast_path, "/") if fast_path == "" else (fast_path,)
            for index, route_path in enumerate(route_paths):
                route_name = func.__name__ if index == 0 else f"{func.__name__}_trailing_slash"
                self.add_api_route(route_path, endpoint, methods=methods, name=route_name)
            return func
        return register
