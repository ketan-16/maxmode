import logging
import unittest
import uuid
from unittest.mock import patch

from fastapi.testclient import TestClient

import main


class _CollectingHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


class AuthAndSyncTests(unittest.TestCase):
    def origin_headers(self):
        return {"origin": "http://testserver"}

    def unique_email(self) -> str:
        return f"maxmode-{uuid.uuid4().hex[:12]}@example.com"

    def sign_up(self, client: TestClient, email: str, password: str = "strong-password-123"):
        response = client.post(
            "/api/auth/sign-up",
            headers=self.origin_headers(),
            json={"email": email, "password": password},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["authenticated"], True)
        return response

    def sign_in(self, client: TestClient, email: str, password: str = "strong-password-123"):
        response = client.post(
            "/api/auth/sign-in",
            headers=self.origin_headers(),
            json={"email": email, "password": password},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["authenticated"], True)
        return response

    def test_sign_up_creates_session_and_reports_empty_server_data(self):
        with TestClient(main.app) as client:
            email = self.unique_email()
            response = self.sign_up(client, email)

            self.assertEqual(response.json()["hasServerData"], False)

            session_response = client.get("/api/auth/session")
            self.assertEqual(session_response.status_code, 200)
            self.assertEqual(
                session_response.json(),
                {
                    "authenticated": True,
                    "email": email,
                    "hasServerData": False,
                },
            )

    def test_sign_in_rejects_invalid_credentials(self):
        email = self.unique_email()
        with TestClient(main.app) as client:
            self.sign_up(client, email)

        with TestClient(main.app) as client:
            response = client.post(
                "/api/auth/sign-in",
                headers=self.origin_headers(),
                json={"email": email, "password": "wrong-password"},
            )

            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json()["detail"], "Invalid email or password.")

    def test_sign_out_clears_session(self):
        with TestClient(main.app) as client:
            self.sign_up(client, self.unique_email())

            sign_out_response = client.post("/api/auth/sign-out", headers=self.origin_headers(), json={})
            self.assertEqual(sign_out_response.status_code, 200)
            self.assertEqual(sign_out_response.json()["ok"], True)

            session_response = client.get("/api/auth/session")
            self.assertEqual(
                session_response.json(),
                {
                    "authenticated": False,
                    "email": None,
                    "hasServerData": False,
                },
            )

    def test_sync_requires_authentication(self):
        with TestClient(main.app) as client:
            response = client.post(
                "/api/sync",
                headers=self.origin_headers(),
                json={"deviceId": "device-a", "lastPulledVersion": 0, "mutations": []},
            )

            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.json()["detail"], "Authentication required.")

    def test_sync_round_trip_persists_profile_weights_and_meals(self):
        email = self.unique_email()
        profile_mutation_id = f"profile-{uuid.uuid4().hex[:12]}"
        weight_id = f"weight-{uuid.uuid4().hex[:12]}"
        weight_mutation_id = f"mutation-{uuid.uuid4().hex[:12]}"
        meal_id = f"meal-{uuid.uuid4().hex[:12]}"
        meal_mutation_id = f"mutation-{uuid.uuid4().hex[:12]}"
        with TestClient(main.app) as client:
            self.sign_up(client, email)

            sync_response = client.post(
                "/api/sync",
                headers=self.origin_headers(),
                json={
                    "deviceId": "device-a",
                    "lastPulledVersion": 0,
                    "mutations": [
                        {
                            "mutationId": profile_mutation_id,
                            "type": "profile.upsert",
                            "entityId": "main",
                            "payload": {
                                "user": {
                                    "name": "Lift Day",
                                    "createdAt": "2026-01-01T00:00:00.000Z",
                                    "calorieProfile": {
                                        "age": 29,
                                        "gender": "male",
                                        "activityLevel": "moderately-active",
                                        "height": {
                                            "unit": "cm",
                                            "cm": 180,
                                            "heightCm": 180,
                                            "ft": 5,
                                            "in": 11,
                                        },
                                    },
                                    "calorieGoal": {
                                        "objective": "gain",
                                        "presetKey": "bulk-lean",
                                    },
                                    "preferences": {
                                        "heightUnit": "cm",
                                        "weightUnit": "kg",
                                        "proteinMultiplierGPerKg": 1.9,
                                        "aiCalculationMode": "aggressive",
                                    },
                                },
                                "calorieTrackerMeta": {
                                    "reminderOptIn": True,
                                    "lastReminderDay": "2026-03-27",
                                },
                            },
                        },
                        {
                            "mutationId": weight_mutation_id,
                            "type": "weight.upsert",
                            "entityId": weight_id,
                            "payload": {
                                "id": weight_id,
                                "weight": 81.65,
                                "unit": "kg",
                                "timestamp": "2026-03-27T06:00:00.000Z",
                            },
                        },
                        {
                            "mutationId": meal_mutation_id,
                            "type": "meal.upsert",
                            "entityId": meal_id,
                            "payload": {
                                "id": meal_id,
                                "name": "Chicken bowl",
                                "source": "manual",
                                "confidence": "high",
                                "portion": 1.25,
                                "baseCalories": 520,
                                "baseProtein": 42,
                                "baseCarbs": 44,
                                "baseFat": 16,
                                "loggedAt": "2026-03-27T12:00:00.000Z",
                            },
                        },
                    ],
                },
            )

            self.assertEqual(sync_response.status_code, 200)
            payload = sync_response.json()
            self.assertEqual(payload["profileChanged"], True)
            self.assertEqual(payload["profile"]["user"]["name"], "Lift Day")
            self.assertEqual(len(payload["weights"]), 1)
            self.assertEqual(payload["weights"][0]["id"], weight_id)
            self.assertEqual(len(payload["meals"]), 1)
            self.assertEqual(payload["meals"][0]["id"], meal_id)
            self.assertGreaterEqual(payload["serverVersion"], 3)

            session_response = client.get("/api/auth/session")
            self.assertEqual(session_response.json()["hasServerData"], True)

        with TestClient(main.app) as client:
            self.sign_in(client, email)
            pull_response = client.post(
                "/api/sync",
                headers=self.origin_headers(),
                json={"deviceId": "device-b", "lastPulledVersion": 0, "mutations": []},
            )

            self.assertEqual(pull_response.status_code, 200)
            payload = pull_response.json()
            self.assertEqual(payload["profileChanged"], True)
            self.assertEqual(payload["profile"]["user"]["name"], "Lift Day")
            self.assertEqual(len(payload["weights"]), 1)
            self.assertEqual(payload["weights"][0]["weight"], 81.65)
            self.assertEqual(len(payload["meals"]), 1)
            self.assertEqual(payload["meals"][0]["name"], "Chicken bowl")

    def test_request_logs_are_emitted_for_api_routes(self):
        with TestClient(main.app) as client:
            with patch.object(main.request_logger, "info") as mock_info:
                response = client.get("/api/auth/session")

        self.assertEqual(response.status_code, 200)
        self.assertIn(main.REQUEST_ID_HEADER, response.headers)
        mock_info.assert_called_once()
        (
            message,
            method,
            path,
            status_code,
            duration_ms,
            client_address,
            request_id,
        ) = mock_info.call_args.args
        self.assertEqual(
            message,
            "http_request method=%s path=%s status=%s duration_ms=%.2f client=%s request_id=%s",
        )
        self.assertEqual(method, "GET")
        self.assertEqual(path, "/api/auth/session")
        self.assertEqual(status_code, 200)
        self.assertGreaterEqual(duration_ms, 0)
        self.assertEqual(client_address, "testclient")
        self.assertEqual(response.headers[main.REQUEST_ID_HEADER], request_id)

    def test_request_logs_remain_enabled_after_database_setup(self):
        handler = _CollectingHandler()
        main.request_logger.addHandler(handler)
        try:
            with TestClient(main.app) as client:
                response = client.get("/api/auth/session")
        finally:
            main.request_logger.removeHandler(handler)

        self.assertEqual(response.status_code, 200)
        self.assertFalse(main.request_logger.disabled)
        self.assertTrue(
            any(
                record.getMessage().startswith(
                    "http_request method=GET path=/api/auth/session status=200"
                )
                for record in handler.records
            )
        )

    def test_startup_disables_uvicorn_access_logger(self):
        uvicorn_access_logger = logging.getLogger("uvicorn.access")
        previous_disabled = uvicorn_access_logger.disabled
        uvicorn_access_logger.disabled = False
        try:
            with TestClient(main.app):
                self.assertTrue(uvicorn_access_logger.disabled)
        finally:
            uvicorn_access_logger.disabled = previous_disabled

    def test_request_logs_are_emitted_for_page_routes(self):
        with TestClient(main.app) as client:
            with patch.object(main.request_logger, "info") as mock_info:
                response = client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertIn(main.REQUEST_ID_HEADER, response.headers)
        mock_info.assert_called_once()
        self.assertEqual(mock_info.call_args.args[1], "GET")
        self.assertEqual(mock_info.call_args.args[2], "/")

    def test_request_logs_skip_static_assets(self):
        with TestClient(main.app) as client:
            with patch.object(main.request_logger, "info") as mock_info:
                response = client.get("/static/js/app.js")

        self.assertEqual(response.status_code, 200)
        mock_info.assert_not_called()


if __name__ == "__main__":
    unittest.main()
