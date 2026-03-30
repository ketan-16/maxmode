import base64
from pathlib import Path
from urllib.parse import urlencode

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from meal_ai import MealAnalysisError, analyze_logged_meal

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_AVATAR_SIZE = 96
MIN_AVATAR_SIZE = 64
MAX_AVATAR_SIZE = 256
NOTIONISTS_AVATAR_API = "https://api.dicebear.com/9.x/notionists/svg"
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

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


class MealEstimate(BaseModel):
    name: str
    calories: int
    protein: int
    carbs: int
    fat: int
    confidence: str


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


async def _read_upload_payload(upload: UploadFile | None):
    if not upload:
        return None

    payload = await upload.read()
    if not payload:
        return None

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
        if image:
            uploads.append(image)
        if isinstance(images, list):
            uploads.extend(images)

        image_payloads = []
        for upload in uploads[:3]:
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
    except MealAnalysisError as exc:
        message = str(exc).strip() or "Unable to analyze this meal right now."
        status_code = 400 if "description or a photo" in message.lower() else 503
        raise HTTPException(status_code=status_code, detail=message) from exc
    except Exception as exc:  # pragma: no cover - defensive API guardrail
        raise HTTPException(status_code=503, detail="Unable to analyze this meal right now.") from exc

    return MealEstimateResponse(meal=MealEstimate(**meal))


@app.get("/service-worker.js")
async def service_worker():
    return FileResponse(
        BASE_DIR / "service-worker.js",
        media_type="application/javascript",
        headers={
            "Service-Worker-Allowed": "/",
            "Cache-Control": "no-cache",
        },
    )
