from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

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


if __name__ == "__main__":
    unittest.main()
