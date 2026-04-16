from __future__ import annotations

import os
import unittest
from unittest.mock import patch

import python_backend


class AppBootstrapModeTests(unittest.TestCase):
    def test_web_background_jobs_mode_defaults_to_thread(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(python_backend._resolve_web_background_jobs_mode(), "thread")

    def test_web_background_jobs_mode_accepts_external(self) -> None:
        with patch.dict(os.environ, {"PEPPRO_WEB_BACKGROUND_JOBS_MODE": "external"}, clear=True):
            self.assertEqual(python_backend._resolve_web_background_jobs_mode(), "external")


if __name__ == "__main__":
    unittest.main()
