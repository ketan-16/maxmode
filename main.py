import base64
import hashlib
import json
import logging
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse
from urllib.parse import urlencode

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from db.auth import (
    AuthError,
    account_has_server_data,
    authenticate_user,
    create_account_with_user,
    get_session_context,
    revoke_session,
)
from db.config import SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS, is_secure_cookie_env
from db.migrations import ensure_database_ready
from db.session import get_db_session
from db.sync import SyncRequest, SyncResponse, apply_sync_request
from meal_ai import MealAnalysisError, analyze_logged_meal

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"
SERVICE_WORKER_TEMPLATE = BASE_DIR / "service-worker.js"
DEFAULT_AVATAR_SIZE = 96
MIN_AVATAR_SIZE = 64
MAX_AVATAR_SIZE = 256
MAX_ANALYSIS_IMAGES = 3
MAX_ANALYSIS_IMAGE_BYTES = 4 * 1024 * 1024
NOTIONISTS_AVATAR_API = "https://api.dicebear.com/9.x/notionists/svg"
REQUEST_LOGGER_NAME = "maxmode.http"
REQUEST_ID_HEADER = "X-Request-ID"
REQUEST_LOG_EXCLUDED_PREFIXES = ("/static",)
PRECACHE_PAGES = (
    "/",
    "/weights",
    "/calories",
    "/profile",
    "/offline",
)
PRECACHE_STATIC_EXTENSIONS = {
    ".css",
    ".js",
    ".json",
    ".mjs",
    ".png",
}
ALL_NOTIONISTS_HAIR_VARIANTS = (
    "variant63",
    "variant62",
    "variant61",
    "variant60",
    "variant59",
    "variant58",
    "variant57",
    "variant56",
    "variant55",
    "variant54",
    "variant53",
    "variant52",
    "variant51",
    "variant50",
    "variant49",
    "variant48",
    "variant47",
    "variant46",
    "variant45",
    "variant44",
    "variant43",
    "variant42",
    "variant41",
    "variant40",
    "variant39",
    "variant38",
    "variant37",
    "variant36",
    "variant35",
    "variant34",
    "variant33",
    "variant32",
    "variant31",
    "variant30",
    "variant29",
    "variant28",
    "variant27",
    "variant26",
    "variant25",
    "variant24",
    "variant23",
    "variant22",
    "variant21",
    "variant20",
    "variant19",
    "variant18",
    "variant17",
    "variant16",
    "variant15",
    "variant14",
    "variant13",
    "variant12",
    "variant11",
    "variant10",
    "variant09",
    "variant08",
    "variant07",
    "variant06",
    "variant05",
    "variant04",
    "variant03",
    "variant02",
    "variant01",
    "hat",
)
FEMALE_HAIR_VARIANTS = (
    "variant02",
    "variant08",
    "variant10",
    "variant23",
    "variant28",
    "variant36",
    "variant41",
    "variant45",
    "variant46",
    "variant47",
    "variant48",
)
MALE_HAIR_VARIANTS = tuple(
    variant for variant in ALL_NOTIONISTS_HAIR_VARIANTS
    if variant not in FEMALE_HAIR_VARIANTS
)

request_logger = logging.getLogger(REQUEST_LOGGER_NAME)
if not request_logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    )
    request_logger.addHandler(handler)
request_logger.setLevel(logging.INFO)
request_logger.propagate = False

app = FastAPI(title="MaxMode")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATES_DIR)


class MealEstimate(BaseModel):
    name: str
    calories: int
    protein: int
    carbs: int
    fat: int
    confidence: str
    sources: list[str] = Field(default_factory=list)


class MealEstimateResponse(BaseModel):
    meal: MealEstimate


class AuthCredentials(BaseModel):
    email: str
    password: str


class AuthSessionResponse(BaseModel):
    authenticated: bool
    email: str | None = None
    hasServerData: bool = False


def _normalize_avatar_name(name: str | None):
    if not isinstance(name, str):
        return "MaxMode Member"

    trimmed = " ".join(name.split()).strip()
    return trimmed[:80] if trimmed else "MaxMode Member"


def _normalize_avatar_gender(gender: str | None):
    if gender == "male":
        return "male"
    if gender == "female":
        return "female"
    return ""


def _normalize_avatar_size(size: int | None):
    if not isinstance(size, int):
        return DEFAULT_AVATAR_SIZE
    return max(MIN_AVATAR_SIZE, min(MAX_AVATAR_SIZE, size))


def _build_profile_picture_url(name: str, gender: str, size: int):
    params = {
        "seed": name,
        "size": str(size),
    }

    if gender == "female":
        params["beardProbability"] = "0"
        params["hair"] = ",".join(FEMALE_HAIR_VARIANTS)
    elif gender == "male":
        params["beardProbability"] = "25"
        params["hair"] = ",".join(MALE_HAIR_VARIANTS)

    return f"{NOTIONISTS_AVATAR_API}?{urlencode(params)}"


def _page_response(request: Request, full: str, partial: str):
    """Return partial template for HTMX requests, full page otherwise."""
    template = partial if request.headers.get("HX-Request") else full
    response = templates.TemplateResponse(request, template)
    response.headers["Vary"] = "HX-Request"
    return response


def _request_origin(request: Request) -> str:
    return f"{request.url.scheme}://{request.url.netloc}"


def _should_log_request(request: Request) -> bool:
    path = request.url.path
    return not path.startswith(REQUEST_LOG_EXCLUDED_PREFIXES)


def _request_id_for_log(request: Request) -> str:
    request_id = request.headers.get(REQUEST_ID_HEADER)
    if request_id:
        return request_id[:128]
    return uuid.uuid4().hex


def _request_client_address(request: Request) -> str:
    if request.client and request.client.host:
        return request.client.host
    return "-"


def _disable_uvicorn_access_logs() -> None:
    access_logger = logging.getLogger("uvicorn.access")
    access_logger.handlers.clear()
    access_logger.propagate = False
    access_logger.disabled = True


_disable_uvicorn_access_logs()


def _enforce_same_origin(request: Request):
    origin = request.headers.get("origin")
    referer = request.headers.get("referer")
    expected_origin = _request_origin(request)

    if origin and origin != expected_origin:
        raise HTTPException(status_code=403, detail="Cross-origin requests are not allowed.")

    if not origin and referer:
        referer_origin = urlparse(referer)
        candidate = f"{referer_origin.scheme}://{referer_origin.netloc}"
        if candidate != expected_origin:
            raise HTTPException(status_code=403, detail="Cross-origin requests are not allowed.")


def _set_session_cookie(response: JSONResponse, raw_token: str):
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=raw_token,
        httponly=True,
        max_age=SESSION_MAX_AGE_SECONDS,
        expires=SESSION_MAX_AGE_SECONDS,
        samesite="lax",
        secure=is_secure_cookie_env(),
        path="/",
    )


def _clear_session_cookie(response: JSONResponse):
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path="/",
        httponly=True,
        samesite="lax",
        secure=is_secure_cookie_env(),
    )


async def _require_session(
    request: Request,
    db_session: AsyncSession = Depends(get_db_session),
):
    session_context = await get_session_context(
        db_session,
        request.cookies.get(SESSION_COOKIE_NAME),
    )
    if session_context is None:
        raise HTTPException(status_code=401, detail="Authentication required.")
    return session_context


def _iter_precache_static_urls() -> list[str]:
    urls: list[str] = []
    for path in sorted(STATIC_DIR.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() not in PRECACHE_STATIC_EXTENSIONS:
            continue
        relative = path.relative_to(STATIC_DIR).as_posix()
        urls.append(f"/static/{relative}")
    return urls


def _build_precache_urls() -> list[str]:
    return [*PRECACHE_PAGES, *_iter_precache_static_urls()]


def _iter_cache_key_files(precache_urls: list[str]) -> list[Path]:
    files = [SERVICE_WORKER_TEMPLATE, BASE_DIR / "main.py"]
    files.extend(sorted(TEMPLATES_DIR.rglob("*.html")))
    for url in precache_urls:
        if not url.startswith("/static/"):
            continue
        files.append(STATIC_DIR / url.removeprefix("/static/"))
    return files


def _build_service_worker_cache_name(precache_urls: list[str]) -> str:
    digest = hashlib.sha256()
    for url in precache_urls:
        digest.update(url.encode("utf-8"))
        digest.update(b"\0")

    for path in _iter_cache_key_files(precache_urls):
        if not path.exists():
            continue
        stat = path.stat()
        digest.update(path.relative_to(BASE_DIR).as_posix().encode("utf-8"))
        digest.update(b":")
        digest.update(str(stat.st_mtime_ns).encode("utf-8"))
        digest.update(b":")
        digest.update(str(stat.st_size).encode("utf-8"))
        digest.update(b"\0")

    return f"maxmode-{digest.hexdigest()[:12]}"


def _render_service_worker() -> str:
    precache_urls = _build_precache_urls()
    cache_name = _build_service_worker_cache_name(precache_urls)
    template = SERVICE_WORKER_TEMPLATE.read_text(encoding="utf-8")
    return (
        template
        .replace("__CACHE_NAME__", json.dumps(cache_name))
        .replace("__PRECACHE_URLS__", json.dumps(precache_urls))
    )


def _validate_analysis_uploads(uploads: list[UploadFile]) -> list[UploadFile]:
    if len(uploads) > MAX_ANALYSIS_IMAGES:
        raise HTTPException(
            status_code=400,
            detail=f"You can upload up to {MAX_ANALYSIS_IMAGES} images per meal.",
        )

    valid_uploads: list[UploadFile] = []
    for upload in uploads:
        if not upload:
            continue
        content_type = (upload.content_type or "").strip().lower()
        if not content_type.startswith("image/"):
            raise HTTPException(status_code=400, detail="Only image uploads are supported.")
        valid_uploads.append(upload)

    return valid_uploads


def _is_upload_like(value: object) -> bool:
    return bool(
        value
        and hasattr(value, "read")
        and hasattr(value, "content_type")
    )


async def _read_upload_payload(upload: UploadFile | None):
    if not upload:
        return None

    payload = await upload.read()
    if not payload:
        return None
    if len(payload) > MAX_ANALYSIS_IMAGE_BYTES:
        max_mb = MAX_ANALYSIS_IMAGE_BYTES / (1024 * 1024)
        raise HTTPException(
            status_code=400,
            detail=f"Each image must be {max_mb:.0f} MB or smaller.",
        )

    return {
        "encoded": base64.b64encode(payload).decode("utf-8"),
        "content_type": upload.content_type or "image/jpeg",
    }


@app.on_event("startup")
async def _startup():
    _disable_uvicorn_access_logs()
    ensure_database_ready()


@app.middleware("http")
async def log_http_requests(request: Request, call_next):
    if not _should_log_request(request):
        return await call_next(request)

    request_id = _request_id_for_log(request)
    request.state.request_id = request_id
    started_at = time.perf_counter()

    try:
        response = await call_next(request)
    except Exception:
        duration_ms = (time.perf_counter() - started_at) * 1000
        request_logger.exception(
            "http_request method=%s path=%s status=500 duration_ms=%.2f client=%s request_id=%s",
            request.method,
            request.url.path,
            duration_ms,
            _request_client_address(request),
            request_id,
        )
        raise

    duration_ms = (time.perf_counter() - started_at) * 1000
    if REQUEST_ID_HEADER not in response.headers:
        response.headers[REQUEST_ID_HEADER] = request_id
    request_logger.info(
        "http_request method=%s path=%s status=%s duration_ms=%.2f client=%s request_id=%s",
        request.method,
        request.url.path,
        response.status_code,
        duration_ms,
        _request_client_address(request),
        request_id,
    )
    return response


@app.get("/")
async def dashboard(request: Request):
    return _page_response(request, "dashboard.html", "partials/dashboard_content.html")


@app.get("/weights")
async def weights(request: Request):
    return _page_response(request, "weights.html", "partials/weights_content.html")


@app.get("/calories")
async def calories(request: Request):
    return _page_response(request, "calories.html", "partials/calories_content.html")


@app.get("/profile")
async def profile(request: Request):
    return _page_response(request, "profile.html", "partials/profile_content.html")


@app.get("/offline")
async def offline(request: Request):
    return templates.TemplateResponse(request, "offline.html")


@app.get("/api/auth/session", response_model=AuthSessionResponse)
async def auth_session(
    request: Request,
    db_session: AsyncSession = Depends(get_db_session),
):
    raw_token = request.cookies.get(SESSION_COOKIE_NAME)
    session_context = await get_session_context(
        db_session,
        raw_token,
    )
    if session_context is None:
        response = JSONResponse(AuthSessionResponse(authenticated=False).model_dump())
        if raw_token:
            _clear_session_cookie(response)
        return response

    payload = AuthSessionResponse(
        authenticated=True,
        email=session_context.email,
        hasServerData=await account_has_server_data(db_session, session_context.account_id),
    )
    response = JSONResponse(payload.model_dump())
    _set_session_cookie(response, session_context.raw_token)
    await db_session.commit()
    return response


@app.post("/api/auth/sign-up", response_model=AuthSessionResponse)
async def auth_sign_up(
    request: Request,
    credentials: AuthCredentials,
    db_session: AsyncSession = Depends(get_db_session),
):
    _enforce_same_origin(request)
    try:
        session_context = await create_account_with_user(
            db_session,
            email=credentials.email,
            password=credentials.password,
        )
    except AuthError as exc:
        await db_session.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    payload = AuthSessionResponse(
        authenticated=True,
        email=session_context.email,
        hasServerData=False,
    )
    response = JSONResponse(payload.model_dump())
    _set_session_cookie(response, session_context.raw_token)
    await db_session.commit()
    return response


@app.post("/api/auth/sign-in", response_model=AuthSessionResponse)
async def auth_sign_in(
    request: Request,
    credentials: AuthCredentials,
    db_session: AsyncSession = Depends(get_db_session),
):
    _enforce_same_origin(request)
    try:
        session_context = await authenticate_user(
            db_session,
            email=credentials.email,
            password=credentials.password,
        )
        has_server_data = await account_has_server_data(db_session, session_context.account_id)
    except AuthError as exc:
        await db_session.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    payload = AuthSessionResponse(
        authenticated=True,
        email=session_context.email,
        hasServerData=has_server_data,
    )
    response = JSONResponse(payload.model_dump())
    _set_session_cookie(response, session_context.raw_token)
    await db_session.commit()
    return response


@app.post("/api/auth/sign-out")
async def auth_sign_out(
    request: Request,
    db_session: AsyncSession = Depends(get_db_session),
):
    _enforce_same_origin(request)
    await revoke_session(db_session, request.cookies.get(SESSION_COOKIE_NAME))
    await db_session.commit()
    response = JSONResponse({"ok": True})
    _clear_session_cookie(response)
    return response


@app.post("/api/sync", response_model=SyncResponse)
async def sync_data(
    request: Request,
    sync_request: SyncRequest,
    session_context=Depends(_require_session),
    db_session: AsyncSession = Depends(get_db_session),
):
    _enforce_same_origin(request)

    try:
        payload = await apply_sync_request(
            db_session,
            account_id=session_context.account_id,
            request=sync_request,
        )
    except AuthError as exc:
        await db_session.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    response = JSONResponse(payload.model_dump())
    _set_session_cookie(response, session_context.raw_token)
    await db_session.commit()
    return response


@app.get("/api/profile/picture")
async def profile_picture(
    name: str = "",
    gender: str = "",
    size: int = DEFAULT_AVATAR_SIZE,
):
    normalized_name = _normalize_avatar_name(name)
    normalized_gender = _normalize_avatar_gender(gender)
    normalized_size = _normalize_avatar_size(size)
    avatar_url = _build_profile_picture_url(normalized_name, normalized_gender, normalized_size)

    return RedirectResponse(
        url=avatar_url,
        headers={
            "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        },
    )


@app.post("/api/calories/analyze", response_model=MealEstimateResponse)
async def analyze_calorie_entry(
    mode: str = Form(default="manual"),
    note: str = Form(default=""),
    goal_objective: str = Form(default=""),
    ai_calculation_mode: str = Form(default=""),
    image: UploadFile | None = File(default=None),
    images: list[UploadFile] | None = File(default=None),
):
    try:
        uploads = []
        if _is_upload_like(image):
            uploads.append(image)
        if isinstance(images, list):
            uploads.extend(upload for upload in images if _is_upload_like(upload))

        uploads = _validate_analysis_uploads(uploads)

        image_payloads = []
        for upload in uploads:
            payload = await _read_upload_payload(upload)
            if payload:
                image_payloads.append(payload)

        meal = analyze_logged_meal(
            note=note,
            image_payloads=image_payloads,
            mode=mode,
            goal_objective=goal_objective,
            ai_calculation_mode=ai_calculation_mode,
        )
    except HTTPException:
        raise
    except MealAnalysisError as exc:
        message = str(exc).strip() or "Unable to analyze this meal right now."
        status_code = 400 if "description or a photo" in message.lower() else 503
        raise HTTPException(status_code=status_code, detail=message) from exc
    except Exception as exc:  # pragma: no cover - defensive API guardrail
        raise HTTPException(status_code=503, detail="Unable to analyze this meal right now.") from exc

    return MealEstimateResponse(meal=MealEstimate(**meal))


@app.get("/service-worker.js")
async def service_worker():
    return Response(
        content=_render_service_worker(),
        media_type="application/javascript",
        headers={
            "Service-Worker-Allowed": "/",
            "Cache-Control": "no-cache",
        },
    )
