from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(title="MaxMode")

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


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


@app.get("/profile")
async def profile(request: Request):
    return _page_response(request, "profile.html", "partials/profile_content.html")


@app.get("/offline")
async def offline(request: Request):
    return templates.TemplateResponse(request, "offline.html")


@app.get("/service-worker.js")
async def service_worker():
    return FileResponse(
        BASE_DIR / "service-worker.js",
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/"},
    )
