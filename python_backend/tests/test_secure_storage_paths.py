from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path
from typing import Any, Dict, List, Tuple
from unittest.mock import patch

from flask import Flask

from python_backend.repositories import patient_links_repository


class _FakeCursor:
    def __init__(self, lastrowid: int = 0) -> None:
        self.lastrowid = lastrowid
        self.calls: List[Tuple[str, Dict[str, Any]]] = []

    def execute(self, query: str, params: Dict[str, Any] | None = None) -> int:
        self.calls.append((query, params or {}))
        return 1


class _CursorContext:
    def __init__(self, cursor: _FakeCursor) -> None:
        self._cursor = cursor

    def __enter__(self) -> _FakeCursor:
        return self._cursor

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False


class SecureStorageWriteTests(unittest.TestCase):
    @staticmethod
    def _load_route_module(name: str):
        try:
            import python_backend  # noqa: F401
        except ModuleNotFoundError as exc:  # pragma: no cover - depends on local env
            raise unittest.SkipTest(f"python deps not installed: {exc}") from exc

        routes_dir = Path(__file__).resolve().parents[1] / "routes"
        package_name = "python_backend.routes"
        module_name = f"{package_name}.{name}"

        package = sys.modules.get(package_name)
        if package is None:
            package = types.ModuleType(package_name)
            package.__path__ = [str(routes_dir)]  # type: ignore[attr-defined]
            sys.modules[package_name] = package

        existing = sys.modules.get(module_name)
        if existing is not None:
            return existing

        spec = importlib.util.spec_from_file_location(module_name, routes_dir / f"{name}.py")
        if spec is None or spec.loader is None:
            raise unittest.SkipTest(f"unable to load route module: {name}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        return module

    def setUp(self) -> None:
        self.app = Flask(__name__)
        self.contact = self._load_route_module("contact")
        self.bugs = self._load_route_module("bugs")

    def _make_response(self, result):
        return self.app.make_response(result)

    def test_contact_form_insert_stores_ciphertext_inline_in_existing_columns(self) -> None:
        cursor = _FakeCursor(lastrowid=321)

        def fake_encrypt(value: Any, *, aad: Dict[str, Any]) -> str | None:
            if value is None:
                return None
            return f"cipher:{aad['field']}:{value}"

        with patch.object(self.contact.mysql_client, "is_enabled", return_value=True), \
            patch.object(self.contact.mysql_client, "cursor", return_value=_CursorContext(cursor)), \
            patch.object(self.contact, "encrypt_text", side_effect=fake_encrypt), \
            patch.object(self.contact, "compute_blind_index", return_value="blind:doctor@example.com"), \
            patch.object(self.contact.sales_rep_repository, "find_by_sales_code", return_value={"id": "rep-7"}), \
            patch.object(self.contact.sales_prospect_repository, "upsert") as upsert, \
            patch.object(self.contact.user_repository, "mark_contact_form_origin_for_email") as mark_origin:
            with self.app.test_request_context(
                "/api/contact",
                method="POST",
                json={
                    "name": "Dr. Jane Example",
                    "email": "Doctor@Example.com",
                    "phone": "555-0100",
                    "source": "PEPPR7",
                },
            ):
                response = self._make_response(self.contact.submit_contact())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"status": "ok"})
        self.assertEqual(len(cursor.calls), 1)

        _query, params = cursor.calls[0]
        self.assertEqual(params["name"], "cipher:name:Dr. Jane Example")
        self.assertEqual(params["email"], "cipher:email:Doctor@Example.com")
        self.assertEqual(params["phone"], "cipher:phone:555-0100")
        self.assertNotIn("name_encrypted", params)
        self.assertNotIn("email_encrypted", params)
        self.assertNotIn("phone_encrypted", params)
        self.assertEqual(params["email_blind_index"], "blind:doctor@example.com")
        self.assertEqual(params["source"], "PEPPR7")

        upsert.assert_called_once_with(
            {
                "id": "contact_form:321",
                "salesRepId": "rep-7",
                "contactFormId": "321",
                "status": "contact_form",
                "isManual": False,
            }
        )
        mark_origin.assert_called_once_with(
            "Doctor@Example.com",
            source="contact_form:321",
        )

    def test_bug_report_insert_stores_ciphertext_inline_in_existing_columns(self) -> None:
        cursor = _FakeCursor()

        def fake_encrypt(value: Any, *, aad: Dict[str, Any]) -> str | None:
            if value is None:
                return None
            return f"cipher:{aad['field']}:{value}"

        with patch.object(self.bugs, "get_config", return_value=types.SimpleNamespace(mysql={"enabled": True})), \
            patch.object(self.bugs, "_resolve_optional_actor", return_value={
                "id": "doctor-5",
                "name": "Dr. Jane Example",
                "email": "doctor@example.com",
            }), \
            patch.object(self.bugs.mysql_client, "cursor", return_value=_CursorContext(cursor)), \
            patch.object(self.bugs, "encrypt_text", side_effect=fake_encrypt), \
            patch.object(self.bugs.usage_tracking_service, "track_event") as track_event:
            with self.app.test_request_context(
                "/api/bugs",
                method="POST",
                json={"report": "Unable to access patient order details."},
            ):
                response = self._make_response(self.bugs.submit_bug_report())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"status": "ok"})
        self.assertEqual(len(cursor.calls), 1)

        query, params = cursor.calls[0]
        self.assertIn("INSERT INTO bugs_reported", query)
        self.assertEqual(params["user_id"], "doctor-5")
        self.assertEqual(params["name"], "cipher:name:Dr. Jane Example")
        self.assertEqual(params["email"], "cipher:email:doctor@example.com")
        self.assertEqual(params["report"], "cipher:report:Unable to access patient order details.")
        self.assertNotIn("name_encrypted", params)
        self.assertNotIn("email_encrypted", params)
        self.assertNotIn("report_encrypted", params)
        track_event.assert_called_once_with(
            "issue_reported",
            actor={
                "id": "doctor-5",
                "name": "Dr. Jane Example",
                "email": "doctor@example.com",
            },
            metadata={"source": "bug_report"},
        )


class PatientLinkEncryptionTests(unittest.TestCase):
    def test_create_link_stores_ciphertext_inline_in_existing_columns(self) -> None:
        calls: List[Tuple[str, Dict[str, Any]]] = []

        def fake_encrypt(value: Any, *, aad: Dict[str, Any]) -> str | None:
            if value is None:
                return None
            return f"cipher:{aad['field']}:{value}"

        def fake_execute(query: str, params: Dict[str, Any] | None = None) -> int:
            calls.append((query, params or {}))
            return 1

        with patch.object(patient_links_repository, "_using_mysql", return_value=True), \
            patch.object(patient_links_repository, "delete_expired"), \
            patch.object(patient_links_repository, "encrypt_text", side_effect=fake_encrypt), \
            patch.object(patient_links_repository.mysql_client, "execute", side_effect=fake_execute), \
            patch.object(patient_links_repository.uuid, "uuid4", return_value="token-1234"):
            link = patient_links_repository.create_link(
                "doctor-9",
                patient_id="PAT-123",
                subject_label="PAT-123",
                study_label="Study A",
                patient_reference="REF-7",
                markup_percent=7.5,
                payment_method="zelle",
                payment_instructions="Pay by Friday",
                instructions="Use nightly",
                allowed_products=["bpc-157"],
            )

        self.assertEqual(link["patientId"], "PAT-123")
        self.assertEqual(link["patientReference"], "REF-7")
        self.assertEqual(len(calls), 1)

        _query, params = calls[0]
        self.assertEqual(params["patient_id"], "cipher:patient_id:PAT-123")
        self.assertEqual(params["reference_label"], "cipher:reference_label:REF-7")
        self.assertEqual(params["subject_label"], "cipher:subject_label:PAT-123")
        self.assertEqual(params["study_label"], "cipher:study_label:Study A")
        self.assertEqual(params["patient_reference"], "cipher:patient_reference:REF-7")
        self.assertEqual(params["instructions"], "cipher:instructions:Use nightly")
        self.assertEqual(
            params["payment_instructions"],
            "cipher:payment_instructions:Pay by Friday",
        )
        self.assertNotIn("patient_id_encrypted", params)
        self.assertNotIn("reference_label_encrypted", params)
        self.assertNotIn("subject_label_encrypted", params)
        self.assertNotIn("study_label_encrypted", params)
        self.assertNotIn("patient_reference_encrypted", params)
        self.assertNotIn("instructions_encrypted", params)
        self.assertNotIn("payment_instructions_encrypted", params)
        self.assertEqual(params["token_ciphertext"], "cipher:token:token-1234")


if __name__ == "__main__":
    unittest.main()
