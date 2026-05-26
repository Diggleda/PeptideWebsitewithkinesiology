from __future__ import annotations

import importlib.util
import json
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
        self.tool_requests = self._load_route_module("tool_requests")

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
            patch.object(self.contact.sales_rep_repository, "find_by_sales_code", return_value={"id": "rep-7"}) as find_sales_code, \
            patch.object(self.contact.user_repository, "find_by_email", return_value=None), \
            patch.object(self.contact.sales_prospect_repository, "find_by_contact_email", return_value=None), \
            patch.object(self.contact.sales_prospect_repository, "upsert") as upsert, \
            patch.object(self.contact.user_repository, "mark_contact_form_origin_for_email") as mark_origin, \
            patch.object(self.contact.email_service, "send_contact_form_received_email") as send_received_email:
            with self.app.test_request_context(
                "/api/contact",
                method="POST",
                json={
                    "name": "Dr. Jane Example",
                    "email": "Doctor@Example.com",
                    "phone": "555-0100",
                    "message": "I would like to join the network.",
                    "source": "join-network",
                    "salesCode": "PEPPR7",
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
        self.assertEqual(params["message"], "cipher:message:I would like to join the network.")
        self.assertEqual(params["message_field_key"], "heard_about_us")
        self.assertEqual(params["message_label"], "How did you hear about us?")
        self.assertNotIn("name_encrypted", params)
        self.assertNotIn("email_encrypted", params)
        self.assertNotIn("phone_encrypted", params)
        self.assertEqual(params["email_blind_index"], "blind:doctor@example.com")
        self.assertEqual(params["source"], "join_network")
        find_sales_code.assert_called_once_with("PEPPR7")

        upsert.assert_called_once()
        self.assertEqual(upsert.call_args.kwargs, {"match_by_contact": False})
        prospect_payload = upsert.call_args.args[0]
        self.assertEqual(prospect_payload["id"], "contact_form:321")
        self.assertEqual(prospect_payload["salesRepId"], "rep-7")
        self.assertIsNone(prospect_payload["doctorId"])
        self.assertEqual(prospect_payload["contactFormId"], "321")
        self.assertEqual(prospect_payload["sourceSystem"], "contact_form")
        self.assertEqual(prospect_payload["sourceExternalId"], "321")
        self.assertEqual(prospect_payload["status"], "contact_form")
        self.assertEqual(prospect_payload["isManual"], False)
        self.assertEqual(prospect_payload["contactName"], "Dr. Jane Example")
        self.assertEqual(prospect_payload["contactEmail"], "Doctor@Example.com")
        self.assertEqual(prospect_payload["contactPhone"], "555-0100")
        self.assertEqual(prospect_payload["contactEmails"], ["Doctor@Example.com"])
        self.assertEqual(prospect_payload["contactPhones"], ["555-0100"])
        self.assertEqual(
            prospect_payload["sourcePayloadJson"]["messageFieldKey"],
            "heard_about_us",
        )
        self.assertEqual(
            prospect_payload["sourcePayloadJson"]["messageLabel"],
            "How did you hear about us?",
        )
        self.assertEqual(prospect_payload["sourcePayloadJson"]["source"], "join_network")
        self.assertEqual(
            prospect_payload["sourcePayloadJson"]["message"],
            "I would like to join the network.",
        )
        mark_origin.assert_called_once_with(
            "Doctor@Example.com",
            source="contact_form:321",
        )
        send_received_email.assert_called_once_with(
            "Doctor@Example.com",
            name="Dr. Jane Example",
        )

    def test_contact_form_existing_doctor_lead_keeps_rep_owner(self) -> None:
        cursor = _FakeCursor(lastrowid=654)

        def fake_encrypt(value: Any, *, aad: Dict[str, Any]) -> str | None:
            if value is None:
                return None
            return f"cipher:{aad['field']}:{value}"

        with patch.object(self.contact.mysql_client, "is_enabled", return_value=True), \
            patch.object(self.contact.mysql_client, "cursor", return_value=_CursorContext(cursor)), \
            patch.object(self.contact, "encrypt_text", side_effect=fake_encrypt), \
            patch.object(self.contact, "compute_blind_index", return_value="blind:doctor@example.com"), \
            patch.object(self.contact.user_repository, "find_by_email", return_value={
                "id": "doctor-9",
                "role": "doctor",
                "salesRepId": "rep-9",
            }) as find_user, \
            patch.object(self.contact.sales_rep_repository, "find_by_sales_code") as find_sales_code, \
            patch.object(self.contact.sales_prospect_repository, "find_by_contact_email") as find_prospect_email, \
            patch.object(self.contact.sales_prospect_repository, "upsert") as upsert, \
            patch.object(self.contact.user_repository, "mark_contact_form_origin_for_email") as mark_origin, \
            patch.object(self.contact.email_service, "send_contact_form_received_email"):
            with self.app.test_request_context(
                "/api/contact",
                method="POST",
                json={
                    "name": "Dr. Jane Example",
                    "email": "Doctor@Example.com",
                    "message": "I have a question.",
                    "source": "contact",
                },
            ):
                response = self._make_response(self.contact.submit_contact())

        self.assertEqual(response.status_code, 200)
        find_user.assert_called_once_with("doctor@example.com")
        find_sales_code.assert_not_called()
        find_prospect_email.assert_not_called()

        upsert.assert_called_once()
        prospect_payload = upsert.call_args.args[0]
        self.assertEqual(prospect_payload["id"], "contact_form:654")
        self.assertEqual(prospect_payload["salesRepId"], "rep-9")
        self.assertEqual(prospect_payload["doctorId"], "doctor-9")
        self.assertEqual(prospect_payload["contactFormId"], "654")
        mark_origin.assert_called_once_with(
            "Doctor@Example.com",
            source="contact_form:654",
        )

    def test_contact_form_existing_prospect_lead_keeps_rep_owner(self) -> None:
        cursor = _FakeCursor(lastrowid=777)

        def fake_encrypt(value: Any, *, aad: Dict[str, Any]) -> str | None:
            if value is None:
                return None
            return f"cipher:{aad['field']}:{value}"

        with patch.object(self.contact.mysql_client, "is_enabled", return_value=True), \
            patch.object(self.contact.mysql_client, "cursor", return_value=_CursorContext(cursor)), \
            patch.object(self.contact, "encrypt_text", side_effect=fake_encrypt), \
            patch.object(self.contact, "compute_blind_index", return_value="blind:doctor@example.com"), \
            patch.object(self.contact.user_repository, "find_by_email", return_value=None), \
            patch.object(self.contact.sales_prospect_repository, "find_by_contact_email", return_value={
                "id": "manual:lead-1",
                "doctorId": "doctor-11",
                "salesRepId": "rep-11",
            }) as find_prospect_email, \
            patch.object(self.contact.sales_rep_repository, "find_by_sales_code") as find_sales_code, \
            patch.object(self.contact.sales_prospect_repository, "upsert") as upsert, \
            patch.object(self.contact.user_repository, "mark_contact_form_origin_for_email"), \
            patch.object(self.contact.email_service, "send_contact_form_received_email"):
            with self.app.test_request_context(
                "/api/contact",
                method="POST",
                json={
                    "name": "Dr. Prospect Example",
                    "email": "prospect@example.com",
                    "message": "Checking in.",
                    "source": "question",
                },
            ):
                response = self._make_response(self.contact.submit_contact())

        self.assertEqual(response.status_code, 200)
        find_prospect_email.assert_called_once_with("prospect@example.com")
        find_sales_code.assert_not_called()

        upsert.assert_called_once()
        prospect_payload = upsert.call_args.args[0]
        self.assertEqual(prospect_payload["id"], "contact_form:777")
        self.assertEqual(prospect_payload["salesRepId"], "rep-11")
        self.assertEqual(prospect_payload["doctorId"], "doctor-11")
        self.assertEqual(prospect_payload["contactFormId"], "777")

    def test_contact_form_admin_sales_code_creates_house_contact(self) -> None:
        cursor = _FakeCursor(lastrowid=888)

        def fake_encrypt(value: Any, *, aad: Dict[str, Any]) -> str | None:
            if value is None:
                return None
            return f"cipher:{aad['field']}:{value}"

        with patch.object(self.contact.mysql_client, "is_enabled", return_value=True), \
            patch.object(self.contact.mysql_client, "cursor", return_value=_CursorContext(cursor)), \
            patch.object(self.contact, "encrypt_text", side_effect=fake_encrypt), \
            patch.object(self.contact, "compute_blind_index", return_value="blind:doctor@example.com"), \
            patch.object(self.contact.user_repository, "find_by_email", return_value=None), \
            patch.object(self.contact.sales_prospect_repository, "find_by_contact_email", return_value=None), \
            patch.object(self.contact.sales_rep_repository, "find_by_sales_code", return_value={
                "id": "admin-rep",
                "role": "admin",
            }) as find_sales_code, \
            patch.object(self.contact.sales_prospect_repository, "upsert") as upsert, \
            patch.object(self.contact.user_repository, "mark_contact_form_origin_for_email"), \
            patch.object(self.contact.email_service, "send_contact_form_received_email"):
            with self.app.test_request_context(
                "/api/contact",
                method="POST",
                json={
                    "name": "Dr. House Example",
                    "email": "house@example.com",
                    "message": "Joining.",
                    "source": "join_network",
                    "salesCode": "ADMIN1",
                },
            ):
                response = self._make_response(self.contact.submit_contact())

        self.assertEqual(response.status_code, 200)
        find_sales_code.assert_called_once_with("ADMIN1")
        upsert.assert_called_once()
        prospect_payload = upsert.call_args.args[0]
        self.assertEqual(prospect_payload["id"], "contact_form:888")
        self.assertEqual(prospect_payload["salesRepId"], "house")
        self.assertIsNone(prospect_payload["doctorId"])
        self.assertEqual(prospect_payload["contactFormId"], "888")

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
                json={
                    "report": "Unable to access patient order details.",
                    "source": "delegate_link",
                },
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
        self.assertEqual(params["source"], "delegate_link")
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
            metadata={"source": "delegate_link"},
        )

    def test_tool_request_insert_stores_ciphertext_inline_in_existing_columns(self) -> None:
        cursor = _FakeCursor()

        def fake_encrypt(value: Any, *, aad: Dict[str, Any]) -> str | None:
            if value is None:
                return None
            return f"cipher:{aad['field']}:{value}"

        actor = {
            "id": "doctor-8",
            "name": "Dr. Tool Builder",
            "email": "tool-doctor@example.com",
        }
        with patch.object(self.tool_requests, "get_config", return_value=types.SimpleNamespace(mysql={"enabled": True})), \
            patch.object(self.tool_requests, "_resolve_optional_actor", return_value=actor), \
            patch.object(self.tool_requests.mysql_client, "cursor", return_value=_CursorContext(cursor)), \
            patch.object(self.tool_requests, "encrypt_text", side_effect=fake_encrypt), \
            patch.object(self.tool_requests.usage_tracking_service, "track_event") as track_event:
            with self.app.test_request_context(
                "/api/tool-requests",
                method="POST",
                json={
                    "report": "A blinded research intake builder.",
                    "source": "research_tab",
                },
            ):
                response = self._make_response(self.tool_requests.submit_tool_request())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"status": "ok"})
        self.assertEqual(len(cursor.calls), 1)

        query, params = cursor.calls[0]
        self.assertIn("INSERT INTO tool_requests", query)
        self.assertEqual(params["user_id"], "doctor-8")
        self.assertEqual(params["name"], "cipher:name:Dr. Tool Builder")
        self.assertEqual(params["email"], "cipher:email:tool-doctor@example.com")
        self.assertEqual(params["report"], "cipher:report:A blinded research intake builder.")
        self.assertEqual(params["source"], "research_tab")
        self.assertNotIn("name_encrypted", params)
        self.assertNotIn("email_encrypted", params)
        self.assertNotIn("report_encrypted", params)
        track_event.assert_called_once_with(
            "tool_request_submitted",
            actor=actor,
            metadata={"source": "research_tab"},
        )


class PatientLinkEncryptionTests(unittest.TestCase):
    def test_map_row_tolerates_unreadable_encrypted_optional_fields(self) -> None:
        bad_envelope = json.dumps(
            {
                "version": 1,
                "wrapped_data_key": {"iv": "bad", "ciphertext": "bad"},
                "iv": "bad",
                "ciphertext": "bad",
            }
        )
        row = {
            "token": "hashed-token",
            "doctor_id": "doctor-9",
            "link_type": "delegate",
            "link_name": bad_envelope,
            "reference_label": "Fallback Link",
            "delegate_cart_json": bad_envelope,
            "payment_confirmation_required": "yes",
            "physician_certified": "false",
            "received_payment": "paid",
            "usage_count": "not-a-number",
            "open_count": "2",
            "view_count": "",
            "markup_percent": "not-a-number",
        }

        with patch.object(patient_links_repository, "decrypt_text", side_effect=RuntimeError("bad decrypt")), \
            patch.object(patient_links_repository, "decrypt_json", side_effect=RuntimeError("bad decrypt")):
            mapped = patient_links_repository._map_row(row)

        self.assertEqual(mapped["linkName"], "Fallback Link")
        self.assertEqual(mapped["usageCount"], 0)
        self.assertEqual(mapped["openCount"], 2)
        self.assertEqual(mapped["viewCount"], 2)
        self.assertEqual(mapped["markupPercent"], 0.0)
        self.assertTrue(mapped["paymentConfirmationRequired"])
        self.assertFalse(mapped["physicianCertified"])
        self.assertTrue(mapped["receivedPayment"])
        self.assertIsNone(mapped["delegateCart"])

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
                link_name="Link Alpha",
                patient_id="PAT-123",
                subject_label="PAT-123",
                study_label="Study A",
                patient_reference="REF-7",
                delegate_name="Delegate A",
                delegate_contact="delegate@example.com",
                delegate_role="caregiver",
                product_scope="specific_products",
                product_scope_items=["bpc-157"],
                delegate_permission="submit_for_physician_review",
                markup_percent=7.5,
                pricing_disclosure="Prices include service fees.",
                zelle_recipient_name="Dr. Example",
                payment_confirmation_required=True,
                delegate_instructions="Review available research products.",
                internal_physician_note="Internal note.",
                terms_version="terms-v1",
                shipping_policy_version="shipping-v1",
                privacy_policy_version="privacy-v1",
                payment_method="zelle",
                payment_instructions="Pay by Friday",
                instructions="Use nightly",
                allowed_products=["bpc-157"],
            )

        self.assertEqual(link["patientId"], "PAT-123")
        self.assertEqual(link["patientReference"], "REF-7")
        self.assertEqual(link["linkName"], "Link Alpha")
        self.assertEqual(link["referenceLabel"], "Link Alpha")
        self.assertEqual(link["label"], "Link Alpha")
        self.assertEqual(len(calls), 1)

        _query, params = calls[0]
        self.assertEqual(params["link_name"], "cipher:link_name:Link Alpha")
        self.assertEqual(params["patient_id"], "cipher:patient_id:PAT-123")
        self.assertEqual(params["reference_label"], "cipher:reference_label:Link Alpha")
        self.assertEqual(params["subject_label"], "cipher:subject_label:PAT-123")
        self.assertEqual(params["study_label"], "cipher:study_label:Study A")
        self.assertEqual(params["patient_reference"], "cipher:patient_reference:REF-7")
        self.assertEqual(params["delegate_name"], "cipher:delegate_name:Delegate A")
        self.assertEqual(params["delegate_contact"], "cipher:delegate_contact:delegate@example.com")
        self.assertEqual(params["delegate_role"], "caregiver")
        self.assertEqual(params["product_scope"], "specific_products")
        self.assertEqual(params["product_scope_items_json"], '["BPC-157"]')
        self.assertEqual(params["delegate_permission"], "submit_for_physician_review")
        self.assertEqual(params["pricing_disclosure"], "cipher:pricing_disclosure:Prices include service fees.")
        self.assertEqual(params["zelle_recipient_name"], "cipher:zelle_recipient_name:Dr. Example")
        self.assertEqual(params["payment_confirmation_required"], 1)
        self.assertEqual(params["delegate_instructions"], "cipher:delegate_instructions:Review available research products.")
        self.assertEqual(params["internal_physician_note"], "cipher:internal_physician_note:Internal note.")
        self.assertEqual(params["terms_version"], "terms-v1")
        self.assertEqual(params["shipping_policy_version"], "shipping-v1")
        self.assertEqual(params["privacy_policy_version"], "privacy-v1")
        self.assertEqual(params["instructions"], "cipher:instructions:Use nightly")
        self.assertEqual(
            params["payment_instructions"],
            "cipher:payment_instructions:Pay by Friday",
        )
        self.assertNotIn("patient_id_encrypted", params)
        self.assertNotIn("link_name_encrypted", params)
        self.assertNotIn("reference_label_encrypted", params)
        self.assertNotIn("subject_label_encrypted", params)
        self.assertNotIn("study_label_encrypted", params)
        self.assertNotIn("patient_reference_encrypted", params)
        self.assertNotIn("delegate_name_encrypted", params)
        self.assertNotIn("delegate_contact_encrypted", params)
        self.assertNotIn("pricing_disclosure_encrypted", params)
        self.assertNotIn("zelle_recipient_name_encrypted", params)
        self.assertNotIn("delegate_instructions_encrypted", params)
        self.assertNotIn("internal_physician_note_encrypted", params)
        self.assertNotIn("instructions_encrypted", params)
        self.assertNotIn("payment_instructions_encrypted", params)
        self.assertEqual(params["token_ciphertext"], "cipher:token:token-1234")

    def test_delete_link_accepts_integer_execute_result(self) -> None:
        with patch.object(patient_links_repository, "_using_mysql", return_value=True), \
            patch.object(patient_links_repository.mysql_client, "fetch_one", return_value={"revoked_at": "2026-04-15T20:00:00+00:00"}), \
            patch.object(patient_links_repository.mysql_client, "execute", return_value=1):
            deleted = patient_links_repository.delete_link("doctor-9", "token-1234")

        self.assertTrue(deleted)

    def test_store_delegate_payload_filters_revoked_status_and_usage_limit(self) -> None:
        calls: List[Tuple[str, Dict[str, Any]]] = []

        def fake_encrypt_json(value: Any, *, aad: Dict[str, Any]) -> str:
            return f"cipher:{aad['field']}:{value}"

        def fake_execute(query: str, params: Dict[str, Any] | None = None) -> int:
            calls.append((query, params or {}))
            return 1

        with patch.object(patient_links_repository, "_using_mysql", return_value=True), \
            patch.object(patient_links_repository, "delete_expired"), \
            patch.object(patient_links_repository, "encrypt_json", side_effect=fake_encrypt_json), \
            patch.object(patient_links_repository.mysql_client, "execute", side_effect=fake_execute):
            stored = patient_links_repository.store_delegate_payload(
                "token-1234",
                cart={"items": []},
                shipping={"shippingAddress": {"country": "US"}},
                payment={"paymentMethod": "zelle"},
                order_id="order-1",
            )

        self.assertTrue(stored)
        self.assertEqual(len(calls), 1)
        query = calls[0][0]
        self.assertIn("AND revoked_at IS NULL", query)
        self.assertIn("COALESCE(status, 'active') NOT IN ('revoked', 'expired')", query)
        self.assertIn("(usage_limit IS NULL OR COALESCE(usage_count, 0) < usage_limit)", query)
        self.assertIn("COALESCE(link_type, 'delegate') <> 'brochure'", query)


if __name__ == "__main__":
    unittest.main()
