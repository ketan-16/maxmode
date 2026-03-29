import unittest
from unittest.mock import patch

from starlette.requests import Request
from fastapi import HTTPException

import main


def make_request(path: str, hx: bool = False) -> Request:
    headers = []
    if hx:
        headers.append((b"hx-request", b"true"))

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("utf-8"),
        "query_string": b"",
        "root_path": "",
        "headers": headers,
        "client": ("127.0.0.1", 12345),
        "server": ("testserver", 80),
        "app": main.app,
    }
    return Request(scope)


class RouteRenderingTests(unittest.IsolatedAsyncioTestCase):
    async def test_dashboard_full_page_response(self):
        response = await main.dashboard(make_request("/"))
        self.assertEqual(response.template.name, "dashboard.html")
        self.assertEqual(response.headers.get("vary"), "HX-Request")

    async def test_dashboard_mobile_bottom_nav_order(self):
        response = await main.dashboard(make_request("/"))
        body = response.body.decode("utf-8")
        bottom_nav_start = body.index('<nav class="app-bottom-nav" aria-label="Primary">')
        bottom_nav_end = body.index("</nav>", bottom_nav_start)
        bottom_nav = body[bottom_nav_start:bottom_nav_end]

        calories_index = bottom_nav.index('data-nav-path="/calories"')
        home_index = bottom_nav.index('data-nav-path="/"')
        weights_index = bottom_nav.index('data-nav-path="/weights"')

        self.assertLess(calories_index, home_index)
        self.assertLess(home_index, weights_index)

    async def test_dashboard_partial_for_hx_request(self):
        response = await main.dashboard(make_request("/", hx=True))
        self.assertEqual(response.template.name, "partials/dashboard_content.html")
        self.assertEqual(response.headers.get("vary"), "HX-Request")

    async def test_weights_partial_for_hx_request(self):
        response = await main.weights(make_request("/weights", hx=True))
        self.assertEqual(response.template.name, "partials/weights_content.html")
        self.assertEqual(response.headers.get("vary"), "HX-Request")

    async def test_calories_full_page_response(self):
        response = await main.calories(make_request("/calories"))
        self.assertEqual(response.template.name, "calories.html")
        self.assertEqual(response.headers.get("vary"), "HX-Request")

    async def test_calories_partial_for_hx_request(self):
        response = await main.calories(make_request("/calories", hx=True))
        self.assertEqual(response.template.name, "partials/calories_content.html")
        self.assertEqual(response.headers.get("vary"), "HX-Request")

    async def test_profile_partial_for_hx_request(self):
        response = await main.profile(make_request("/profile", hx=True))
        self.assertEqual(response.template.name, "partials/profile_content.html")
        self.assertEqual(response.headers.get("vary"), "HX-Request")

    async def test_vary_header_for_hx_routes(self):
        for path, handler in (
            ("/", main.dashboard),
            ("/weights", main.weights),
            ("/calories", main.calories),
            ("/profile", main.profile),
        ):
            with self.subTest(path=path):
                response = await handler(make_request(path))
                self.assertEqual(response.headers.get("vary"), "HX-Request")

    async def test_service_worker_headers(self):
        response = await main.service_worker()
        self.assertEqual(response.headers.get("service-worker-allowed"), "/")
        cache_control = response.headers.get("cache-control", "")
        self.assertIn("no-cache", cache_control)

    @patch("main.analyze_logged_meal")
    async def test_calorie_analysis_endpoint_returns_structured_meal(self, mock_analyze):
        mock_analyze.return_value = {
            "name": "Chicken bowl",
            "calories": 620,
            "protein": 38,
            "carbs": 58,
            "fat": 22,
            "confidence": "high",
        }

        response = await main.analyze_calorie_entry(mode="manual", note="chicken rice bowl", image=None)

        self.assertEqual(response.meal.name, "Chicken bowl")
        self.assertEqual(response.meal.calories, 620)
        self.assertEqual(response.meal.confidence, "high")

    @patch("main.analyze_logged_meal")
    async def test_calorie_analysis_endpoint_maps_input_errors_to_400(self, mock_analyze):
        mock_analyze.side_effect = main.MealAnalysisError("Add a meal description or a photo.")

        with self.assertRaises(HTTPException) as context:
            await main.analyze_calorie_entry(mode="manual", note="", image=None)

        self.assertEqual(context.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
