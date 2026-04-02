import base64
import hashlib
import json
from pathlib import Path
from urllib.parse import urlencode

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field

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
