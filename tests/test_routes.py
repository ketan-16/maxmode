import unittest
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch

from starlette.requests import Request
from fastapi import HTTPException

import main

FEMALE_HAIR = ",".join(main.FEMALE_HAIR_VARIANTS)
MALE_HAIR = ",".join(main.MALE_HAIR_VARIANTS)


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

    async def test_dashboard_markup_includes_root_marker(self):
        response = await main.dashboard(make_request("/", hx=True))
        body = response.body.decode("utf-8")
        self.assertIn('id="dashboard-page-root"', body)
        self.assertIn('id="dashboard-goal-card"', body)
        self.assertIn('id="dashboard-macro-card"', body)
        self.assertIn('id="dashboard-macro-center-value"', body)
        self.assertNotIn("30/40/30", body)
        self.assertIn('id="dashboard-weight-summary-card"', body)
        self.assertIn('id="dashboard-weekly-card"', body)
        self.assertIn('id="dashboard-streak-card"', body)
        self.assertIn('id="dashboard-meals-card"', body)

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
        body = response.body.decode("utf-8")
        self.assertIn('id="profile-ai-calculation-mode"', body)
        self.assertIn('id="profile-protein-multiplier-input"', body)
        self.assertIn('id="profile-protein-target-input"', body)

    async def test_profile_picture_endpoint_returns_notionists_redirect(self):
        response = await main.profile_picture(name="Alex", gender="female", size=128)
        location = response.headers.get("location", "")
        parsed = urlparse(location)
        query = parse_qs(parsed.query)

        self.assertEqual(response.status_code, 307)
        self.assertEqual(response.headers.get("cache-control"), "public, max-age=86400, stale-while-revalidate=604800")
        self.assertEqual(parsed.scheme, "https")
        self.assertEqual(parsed.netloc, "api.dicebear.com")
        self.assertEqual(parsed.path, "/9.x/notionists/svg")
        self.assertEqual(query["seed"], ["Alex"])
        self.assertEqual(query["size"], ["128"])
        self.assertEqual(query["beardProbability"], ["0"])
        self.assertEqual(query["hair"], [FEMALE_HAIR])

    async def test_profile_picture_endpoint_varies_by_gender(self):
        male_location = (await main.profile_picture(name="Alex", gender="male", size=96)).headers.get("location", "")
        female_location = (await main.profile_picture(name="Alex", gender="female", size=96)).headers.get("location", "")
        male_query = parse_qs(urlparse(male_location).query)
        female_query = parse_qs(urlparse(female_location).query)

        self.assertEqual(male_query["seed"], ["Alex"])
        self.assertEqual(female_query["seed"], ["Alex"])
        self.assertEqual(male_query["beardProbability"], ["25"])
        self.assertEqual(female_query["beardProbability"], ["0"])
        self.assertEqual(male_query["hair"], [MALE_HAIR])
        self.assertEqual(female_query["hair"], [FEMALE_HAIR])
        self.assertNotEqual(male_location, female_location)

    async def test_profile_picture_endpoint_normalizes_invalid_input(self):
        response = await main.profile_picture(name=" ", gender="unknown", size=12)
        query = parse_qs(urlparse(response.headers.get("location", "")).query)

        self.assertEqual(query["seed"], ["MaxMode Member"])
        self.assertEqual(query["size"], ["64"])
        self.assertNotIn("beardProbability", query)
        self.assertNotIn("hair", query)

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

        response = await main.analyze_calorie_entry(
            mode="manual",
            note="chicken rice bowl",
            goal_objective="lose",
            ai_calculation_mode="aggressive",
            image=None,
        )

        self.assertEqual(response.meal.name, "Chicken bowl")
        self.assertEqual(response.meal.calories, 620)
        self.assertEqual(response.meal.confidence, "high")
        mock_analyze.assert_called_once_with(
            note="chicken rice bowl",
            image_payloads=[],
            mode="manual",
            goal_objective="lose",
            ai_calculation_mode="aggressive",
        )

    @patch("main.analyze_logged_meal")
    async def test_calorie_analysis_endpoint_maps_input_errors_to_400(self, mock_analyze):
        mock_analyze.side_effect = main.MealAnalysisError("Add a meal description or a photo.")

        with self.assertRaises(HTTPException) as context:
            await main.analyze_calorie_entry(mode="manual", note="", image=None)

        self.assertEqual(context.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
