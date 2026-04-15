from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sys
import types
import unittest
from pathlib import Path


def _load_sync_catalog_snapshot_module():
    module_name = "python_backend.scripts.sync_catalog_snapshot"
    script_path = Path(__file__).resolve().parents[1] / "scripts" / "sync_catalog_snapshot.py"

    existing = sys.modules.pop(module_name, None)
    service_module = sys.modules.get("python_backend.services.catalog_snapshot_service")
    bootstrap_module = sys.modules.get("python_backend.worker_bootstrap")

    calls: dict[str, object] = {}

    fake_service = types.ModuleType("python_backend.services.catalog_snapshot_service")

    def fake_sync_catalog_snapshots(*, include_variations: bool = True):
        calls["include_variations"] = include_variations
        result = calls.get("result")
        if isinstance(result, dict):
            return result
        return {"ok": True}

    fake_service.sync_catalog_snapshots = fake_sync_catalog_snapshots

    fake_bootstrap = types.ModuleType("python_backend.worker_bootstrap")

    def fake_bootstrap_fn():
        calls["bootstrapped"] = True
        return None

    fake_bootstrap.bootstrap = fake_bootstrap_fn

    sys.modules["python_backend.services.catalog_snapshot_service"] = fake_service
    sys.modules["python_backend.worker_bootstrap"] = fake_bootstrap

    try:
        spec = importlib.util.spec_from_file_location(module_name, script_path)
        if spec is None or spec.loader is None:
            raise unittest.SkipTest("unable to load sync_catalog_snapshot.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        return module, calls
    finally:
        if existing is not None:
            sys.modules[module_name] = existing
        else:
            sys.modules.pop(module_name, None)
        if service_module is not None:
            sys.modules["python_backend.services.catalog_snapshot_service"] = service_module
        else:
            sys.modules.pop("python_backend.services.catalog_snapshot_service", None)
        if bootstrap_module is not None:
            sys.modules["python_backend.worker_bootstrap"] = bootstrap_module
        else:
            sys.modules.pop("python_backend.worker_bootstrap", None)


class SyncCatalogSnapshotScriptTests(unittest.TestCase):
    def test_main_defaults_to_variation_sync_and_returns_zero_on_success(self):
        module, calls = _load_sync_catalog_snapshot_module()
        calls["result"] = {"ok": True, "products": 12}

        stdout = io.StringIO()
        argv = sys.argv[:]
        try:
            sys.argv = ["sync_catalog_snapshot.py"]
            with contextlib.redirect_stdout(stdout):
                exit_code = module.main()
        finally:
            sys.argv = argv

        self.assertEqual(exit_code, 0)
        self.assertTrue(calls.get("bootstrapped"))
        self.assertEqual(calls.get("include_variations"), True)
        self.assertEqual(json.loads(stdout.getvalue()), {"ok": True, "products": 12})

    def test_main_honors_skip_variations_flag(self):
        module, calls = _load_sync_catalog_snapshot_module()
        calls["result"] = {"ok": True, "products": 4, "variableProducts": 0}

        stdout = io.StringIO()
        argv = sys.argv[:]
        try:
            sys.argv = ["sync_catalog_snapshot.py", "--skip-variations"]
            with contextlib.redirect_stdout(stdout):
                exit_code = module.main()
        finally:
            sys.argv = argv

        self.assertEqual(exit_code, 0)
        self.assertEqual(calls.get("include_variations"), False)
        self.assertEqual(json.loads(stdout.getvalue())["variableProducts"], 0)

    def test_main_returns_zero_for_skipped_result(self):
        module, calls = _load_sync_catalog_snapshot_module()
        calls["result"] = {"ok": False, "skipped": True, "reason": "lock_busy"}

        stdout = io.StringIO()
        argv = sys.argv[:]
        try:
            sys.argv = ["sync_catalog_snapshot.py"]
            with contextlib.redirect_stdout(stdout):
                exit_code = module.main()
        finally:
            sys.argv = argv

        self.assertEqual(exit_code, 0)
        self.assertEqual(json.loads(stdout.getvalue())["reason"], "lock_busy")

    def test_main_returns_nonzero_for_real_failure(self):
        module, calls = _load_sync_catalog_snapshot_module()
        calls["result"] = {"ok": False, "error": "woo_unavailable"}

        stdout = io.StringIO()
        argv = sys.argv[:]
        try:
            sys.argv = ["sync_catalog_snapshot.py"]
            with contextlib.redirect_stdout(stdout):
                exit_code = module.main()
        finally:
            sys.argv = argv

        self.assertEqual(exit_code, 1)
        self.assertEqual(json.loads(stdout.getvalue())["error"], "woo_unavailable")


if __name__ == "__main__":
    unittest.main()
