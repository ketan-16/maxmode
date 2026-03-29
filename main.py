from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from meal_ai import MealAnalysisError, analyze_logged_meal

BASE_DIR = Path(__file__).resolve().parent

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


def _page_response(request: Request, full: str, partial: str):
    """Return partial template for HTMX requests, full page otherwise."""
    template = partial if request.headers.get("HX-Request") else full
    response = templates.TemplateResponse(request, template)
    response.headers["Vary"] = "HX-Request"
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


@app.post("/api/calories/analyze", response_model=MealEstimateResponse)
async def analyze_calorie_entry(
    mode: str = Form(default="manual"),
    note: str = Form(default=""),
    image: UploadFile | None = File(default=None),
):
    try:
        image_bytes = await image.read() if image else None
        content_type = image.content_type if image else None
        meal = analyze_logged_meal(
            note=note,
            image_bytes=image_bytes,
            content_type=content_type,
            mode=mode,
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
