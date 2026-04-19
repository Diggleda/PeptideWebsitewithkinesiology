from __future__ import annotations

import os
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

from flask import Flask

from python_backend.routes import system


class SystemRouteHealthTests(unittest.TestCase):
    def test_parse_gunicorn_args_extracts_recycle_and_thread_settings(self) -> None:
        parsed = system._parse_gunicorn_args(
            "gunicorn python_backend.wsgi:app --workers 2 --threads 8 --timeout 120 "
            "--graceful-timeout 90 --max-requests 200 --max-requests-jitter 25 "
            "--keep-alive 5 --worker-class gthread"
        )

        self.assertEqual(
            parsed,
            {
                "workers": 2,
                "threads": 8,
                "timeoutSeconds": 120,
                "gracefulTimeoutSeconds": 90,
                "maxRequests": 200,
                "maxRequestsJitter": 25,
                "keepAliveSeconds": 5,
                "workerClass": "gthread",
            },
        )

    def test_parse_gunicorn_args_supports_short_worker_class_flag(self) -> None:
        parsed = system._parse_gunicorn_args("gunicorn python_backend.wsgi:app -k gthread --threads=8")

        self.assertEqual(parsed, {"threads": 8, "workerClass": "gthread"})

    def test_assess_background_jobs_health_ignores_external_and_disabled_jobs(self) -> None:
        assessed = system._assess_background_jobs_health(
            {
                "shipstationStatusSync": {
                    "enabled": True,
                    "mode": "external",
                    "running": False,
                    "supervisorAlive": False,
                    "intervalSeconds": 30,
                },
                "patientLinksSweep": {
                    "enabled": False,
                    "mode": "thread",
                    "running": False,
                    "supervisorAlive": False,
                    "intervalSeconds": 900,
                },
            }
        )

        self.assertEqual(assessed["status"], "ok")
        self.assertEqual(assessed["jobs"]["shipstationStatusSync"]["lifecycle"], "external")
        self.assertEqual(assessed["jobs"]["patientLinksSweep"]["lifecycle"], "disabled")

    def test_assess_background_jobs_health_marks_stale_thread_degraded(self) -> None:
        stale_at = (datetime.now(timezone.utc) - timedelta(seconds=600)).isoformat().replace("+00:00", "Z")

        assessed = system._assess_background_jobs_health(
            {
                "presenceSweep": {
                    "enabled": True,
                    "mode": "thread",
                    "running": True,
                    "supervisorAlive": True,
                    "intervalSeconds": 60,
                    "lastHeartbeatAt": stale_at,
                }
            }
        )

        self.assertEqual(assessed["status"], "degraded")
        self.assertEqual(assessed["unhealthyJobs"], ["presenceSweep"])
        self.assertEqual(assessed["jobs"]["presenceSweep"]["health"]["reason"], "stale_heartbeat")

    def test_assess_background_jobs_health_marks_dead_thread_degraded(self) -> None:
        assessed = system._assess_background_jobs_health(
            {
                "productDocumentSync": {
                    "enabled": True,
                    "mode": "thread",
                    "running": False,
                    "supervisorAlive": False,
                    "intervalSeconds": 180,
                }
            }
        )

        self.assertEqual(assessed["status"], "degraded")
        self.assertEqual(assessed["jobs"]["productDocumentSync"]["health"]["reason"], "thread_not_running")

    def test_normalize_background_job_modes_for_health_externalizes_thread_jobs(self) -> None:
        normalized = system._normalize_background_job_modes_for_health(
            {
                "presenceSweep": {
                    "enabled": True,
                    "mode": "thread",
                    "running": False,
                },
                "patientLinksSweep": {
                    "enabled": False,
                    "mode": "thread",
                    "running": False,
                },
            },
            web_mode="external",
        )

        self.assertEqual(normalized["presenceSweep"]["mode"], "external")
        self.assertEqual(normalized["presenceSweep"]["state"], "external")
        self.assertEqual(normalized["presenceSweep"]["reason"], "external_mode")
        self.assertEqual(normalized["patientLinksSweep"]["mode"], "thread")

    def test_health_route_requires_basic_auth(self) -> None:
        app = Flask(__name__)
        app.register_blueprint(system.blueprint)

        with app.test_client() as client, patch.dict(
            os.environ,
            {
                "PEPPRO_HEALTH_BASIC_AUTH_USERNAME": "health-user",
                "PEPPRO_HEALTH_BASIC_AUTH_PASSWORD": "health-pass",
            },
            clear=False,
        ):
            response = client.get("/api/health")

        self.assertEqual(response.status_code, 401)
        self.assertIn("Basic realm=", response.headers.get("WWW-Authenticate", ""))
        self.assertEqual(
            response.get_json(),
            {
                "error": "Server health requires Basic Auth.",
                "code": "BASIC_AUTH_REQUIRED",
            },
        )

    def test_health_route_rejects_non_basic_authorization(self) -> None:
        app = Flask(__name__)
        app.register_blueprint(system.blueprint)

        with app.test_client() as client, patch.dict(
            os.environ,
            {
                "PEPPRO_HEALTH_BASIC_AUTH_USERNAME": "health-user",
                "PEPPRO_HEALTH_BASIC_AUTH_PASSWORD": "health-pass",
            },
            clear=False,
        ):
            response = client.get(
                "/api/health",
                headers={"Authorization": "Bearer test-token"},
            )

        self.assertEqual(response.status_code, 401)
        self.assertEqual(
            response.get_json(),
            {
                "error": "Server health requires Basic Auth.",
                "code": "BASIC_AUTH_REQUIRED",
            },
        )

    def test_health_route_returns_payload_for_valid_basic_auth(self) -> None:
        app = Flask(__name__)
        app.register_blueprint(system.blueprint)

        with app.test_client() as client, patch.object(
            system,
            "get_config",
            return_value=SimpleNamespace(backend_build="test-build", mysql={"enabled": True}),
        ), patch.object(
            system,
            "_server_usage",
            return_value=None,
        ), patch.object(
            system,
            "_background_job_stats",
            return_value={"status": "ok", "jobs": {}, "unhealthyJobs": [], "webProcessMode": "thread"},
        ), patch.object(
            system,
            "_read_cgroup_memory",
            return_value=None,
        ), patch.object(
            system,
            "_process_uptime_seconds",
            return_value=42.0,
        ), patch.object(
            system,
            "_configured_worker_target",
            return_value=4,
        ), patch.object(
            system,
            "_detect_worker_count",
            return_value=4,
        ), patch.object(
            system,
            "_read_proc_cmdline",
            return_value="gunicorn python_backend.wsgi:app --workers 4 --threads 4 --timeout 120",
        ), patch.object(
            system,
            "_read_process_snapshot",
            return_value=None,
        ), patch.object(
            system,
            "_read_child_processes",
            return_value=[],
        ), patch.dict(
            os.environ,
            {
                "PEPPRO_HEALTH_BASIC_AUTH_USERNAME": "health-user",
                "PEPPRO_HEALTH_BASIC_AUTH_PASSWORD": "health-pass",
            },
            clear=False,
        ):
            response = client.get(
                "/api/health",
                headers=self._basic_auth_header("health-user", "health-pass"),
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["build"], "test-build")
        self.assertEqual(payload["mysql"], {"enabled": True})

    def test_health_route_returns_503_when_basic_auth_not_configured(self) -> None:
        app = Flask(__name__)
        app.register_blueprint(system.blueprint)

        with app.test_client() as client, patch.dict(
            os.environ,
            {
                "PEPPRO_HEALTH_BASIC_AUTH_USERNAME": "",
                "PEPPRO_HEALTH_BASIC_AUTH_PASSWORD": "",
            },
            clear=False,
        ):
            response = client.get("/api/health")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.get_json(),
            {
                "error": "Server health Basic Auth is not configured.",
                "code": "BASIC_AUTH_NOT_CONFIGURED",
            },
        )

    def test_ping_route_is_public(self) -> None:
        app = Flask(__name__)
        app.register_blueprint(system.blueprint)

        with app.test_client() as client:
            response = client.get("/api/ping")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["ok"])
        self.assertIn("timestamp", payload)


if __name__ == "__main__":
    unittest.main()
