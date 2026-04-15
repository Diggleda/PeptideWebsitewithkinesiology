from __future__ import annotations

import unittest

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


if __name__ == "__main__":
    unittest.main()
