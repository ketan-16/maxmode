import unittest
import uuid

from fastapi.testclient import TestClient

import main


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
                            "mutationId": "profile-1",
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
                            "mutationId": "weight-1",
                            "type": "weight.upsert",
                            "entityId": "weight-1",
                            "payload": {
                                "id": "weight-1",
                                "weight": 81.65,
                                "unit": "kg",
                                "timestamp": "2026-03-27T06:00:00.000Z",
                            },
                        },
                        {
                            "mutationId": "meal-1",
                            "type": "meal.upsert",
                            "entityId": "meal-1",
                            "payload": {
                                "id": "meal-1",
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
            self.assertEqual(payload["weights"][0]["id"], "weight-1")
            self.assertEqual(len(payload["meals"]), 1)
            self.assertEqual(payload["meals"][0]["id"], "meal-1")
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


if __name__ == "__main__":
    unittest.main()
