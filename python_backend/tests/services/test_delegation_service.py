import sys
import types
import unittest
from datetime import datetime, timezone


def _install_test_stubs() -> None:
    if "cryptography" not in sys.modules:
        cryptography = types.ModuleType("cryptography")
        hazmat = types.ModuleType("cryptography.hazmat")
        primitives = types.ModuleType("cryptography.hazmat.primitives")
        ciphers = types.ModuleType("cryptography.hazmat.primitives.ciphers")
        aead = types.ModuleType("cryptography.hazmat.primitives.ciphers.aead")

        class AESGCM:
            def __init__(self, *_args, **_kwargs):
                pass

            def encrypt(self, _iv, data, _aad):
                return data

            def decrypt(self, _iv, data, _aad):
                return data

        aead.AESGCM = AESGCM
        sys.modules["cryptography"] = cryptography
        sys.modules["cryptography.hazmat"] = hazmat
        sys.modules["cryptography.hazmat.primitives"] = primitives
        sys.modules["cryptography.hazmat.primitives.ciphers"] = ciphers
        sys.modules["cryptography.hazmat.primitives.ciphers.aead"] = aead

    if "pymysql" not in sys.modules:
        pymysql = types.ModuleType("pymysql")
        pymysql_cursors = types.ModuleType("pymysql.cursors")

        class DictCursor:
            pass

        pymysql_cursors.DictCursor = DictCursor

        class _Connections(types.SimpleNamespace):
            class Connection:
                pass

        pymysql.connections = _Connections()

        def connect(*_args, **_kwargs):
            raise RuntimeError("pymysql.connect called during unit test")

        pymysql.connect = connect
        sys.modules["pymysql"] = pymysql
        sys.modules["pymysql.cursors"] = pymysql_cursors

    if "requests" not in sys.modules:
        requests = types.ModuleType("requests")
        requests_auth = types.ModuleType("requests.auth")

        def _blocked(*_args, **_kwargs):
            raise RuntimeError("requests used during unit test")

        class HTTPBasicAuth:
            def __init__(self, *_args, **_kwargs):
                pass

        requests.get = _blocked
        requests.post = _blocked
        requests.put = _blocked
        requests.patch = _blocked
        requests.delete = _blocked
        requests_auth.HTTPBasicAuth = HTTPBasicAuth
        sys.modules["requests"] = requests
        sys.modules["requests.auth"] = requests_auth


class DelegationServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        _install_test_stubs()
        from python_backend.services import delegation_service

        cls.delegation_service = delegation_service

    def test_validate_non_phi_label_rejects_email(self):
        with self.assertRaises(ValueError) as ctx:
            self.delegation_service._validate_non_phi_label(
                "subject@example.com",
                field_name="subjectLabel",
            )
        self.assertEqual(getattr(ctx.exception, "status", None), 400)

    def test_validate_research_note_rejects_dosing_language(self):
        with self.assertRaises(ValueError) as ctx:
            self.delegation_service._validate_research_note(
                "Use this dosage schedule for treatment.",
                field_name="instructions",
            )
        self.assertEqual(getattr(ctx.exception, "status", None), 400)

    def test_sanitize_audit_payload_strips_phi_keys(self):
        sanitized = self.delegation_service._sanitize_audit_payload(
            {
                "subjectLabel": "John Doe",
                "patientReference": "MRN-123",
                "markupPercent": 12.5,
                "allowedProductsCount": 2,
                "nested": {
                    "studyLabel": "Jane Doe",
                    "status": "active",
                },
            }
        )

        self.assertEqual(
            sanitized,
            {
                "markupPercent": 12.5,
                "allowedProductsCount": 2,
                "nested": {"status": "active"},
            },
        )

    def test_validate_delegate_items_enforces_allowed_products(self):
        service = self.delegation_service
        original_find = service.patient_links_repository.find_by_token
        original_audit = service._audit_event
        try:
            service.patient_links_repository.find_by_token = lambda *_args, **_kwargs: {
                "doctorId": "doc-1",
                "allowedProducts": ["BPC-157-5MG"],
            }
            service._audit_event = lambda *_args, **_kwargs: None

            allowed = service.validate_delegate_items(
                "abc123",
                [{"sku": "BPC-157-5MG", "name": "BPC-157", "quantity": 1}],
            )
            self.assertEqual(len(allowed.get("validatedItems") or []), 1)

            with self.assertRaises(ValueError) as ctx:
                service.validate_delegate_items(
                    "abc123",
                    [{"sku": "TB-500-10MG", "name": "TB-500", "quantity": 1}],
                )
            self.assertEqual(getattr(ctx.exception, "status", None), 403)
        finally:
            service.patient_links_repository.find_by_token = original_find
            service._audit_event = original_audit

    def test_review_link_proposal_persists_review_notes(self):
        service = self.delegation_service
        original_using_mysql = service._using_mysql
        original_migrate = service._migrate_legacy_links_to_table
        original_find = service.patient_links_repository.find_by_token
        original_set_status = service.patient_links_repository.set_delegate_review_status
        original_audit = service._audit_event
        try:
            service._using_mysql = lambda: True
            service._migrate_legacy_links_to_table = lambda: None

            call_state = {"count": 0, "notes": None, "delegate_payment": None}

            def fake_find(_token, include_inactive=False):
                call_state["count"] += 1
                if call_state["count"] == 1:
                    return {
                        "doctorId": "doc-1",
                        "revokedAt": None,
                        "delegateSharedAt": "2026-03-12T10:00:00+00:00",
                        "delegatePayment": {"paymentMethod": "bacs"},
                    }
                return {
                    "doctorId": "doc-1",
                    "delegateReviewStatus": "rejected",
                    "delegateReviewedAt": "2026-03-12T10:05:00+00:00",
                    "delegateReviewOrderId": None,
                    "delegateReviewNotes": call_state["notes"],
                    "delegatePayment": call_state["delegate_payment"],
                }

            def fake_set_status(doctor_id, token, *, status, order_id=None, notes=None, delegate_payment=None, reviewed_at=None):
                self.assertEqual(doctor_id, "doc-1")
                self.assertEqual(token, "tok-1")
                self.assertEqual(status, "rejected")
                self.assertIsNone(order_id)
                self.assertIsInstance(reviewed_at, datetime)
                call_state["notes"] = notes
                call_state["delegate_payment"] = delegate_payment
                return True

            service.patient_links_repository.find_by_token = fake_find
            service.patient_links_repository.set_delegate_review_status = fake_set_status
            service._audit_event = lambda *_args, **_kwargs: None

            result = service.review_link_proposal(
                "doc-1",
                "tok-1",
                status="rejected",
                notes="Please remove the duplicate vial and resubmit.",
            )

            self.assertEqual(result.get("proposalStatus"), "rejected")
            self.assertEqual(
                result.get("proposalReviewNotes"),
                "Please remove the duplicate vial and resubmit.",
            )
            self.assertIsNone(result.get("amountDue"))
        finally:
            service._using_mysql = original_using_mysql
            service._migrate_legacy_links_to_table = original_migrate
            service.patient_links_repository.find_by_token = original_find
            service.patient_links_repository.set_delegate_review_status = original_set_status
            service._audit_event = original_audit

    def test_review_link_proposal_persists_amount_due_in_delegate_payment(self):
        service = self.delegation_service
        original_using_mysql = service._using_mysql
        original_migrate = service._migrate_legacy_links_to_table
        original_find = service.patient_links_repository.find_by_token
        original_set_status = service.patient_links_repository.set_delegate_review_status
        original_audit = service._audit_event
        try:
            service._using_mysql = lambda: True
            service._migrate_legacy_links_to_table = lambda: None

            call_state = {"count": 0, "delegate_payment": None}

            def fake_find(_token, include_inactive=False):
                call_state["count"] += 1
                if call_state["count"] == 1:
                    return {
                        "doctorId": "doc-1",
                        "revokedAt": None,
                        "delegateSharedAt": "2026-03-12T10:00:00+00:00",
                        "delegatePayment": {"paymentMethod": "bacs"},
                    }
                return {
                    "doctorId": "doc-1",
                    "delegateReviewStatus": "accepted",
                    "delegateReviewedAt": "2026-03-12T10:05:00+00:00",
                    "delegateReviewOrderId": "woo-123",
                    "delegateReviewNotes": None,
                    "delegatePayment": call_state["delegate_payment"],
                }

            def fake_set_status(doctor_id, token, *, status, order_id=None, notes=None, delegate_payment=None, reviewed_at=None):
                self.assertEqual(doctor_id, "doc-1")
                self.assertEqual(token, "tok-1")
                self.assertEqual(status, "accepted")
                self.assertEqual(order_id, "woo-123")
                self.assertIsNone(notes)
                self.assertIsInstance(reviewed_at, datetime)
                call_state["delegate_payment"] = delegate_payment
                return True

            service.patient_links_repository.find_by_token = fake_find
            service.patient_links_repository.set_delegate_review_status = fake_set_status
            service._audit_event = lambda *_args, **_kwargs: None

            result = service.review_link_proposal(
                "doc-1",
                "tok-1",
                status="accepted",
                order_id="woo-123",
                amount_due="123.45",
                amount_due_currency="usd",
            )

            self.assertEqual(call_state["delegate_payment"].get("paymentMethod"), "bacs")
            self.assertEqual(call_state["delegate_payment"].get("amountDue"), 123.45)
            self.assertEqual(call_state["delegate_payment"].get("amountDueCurrency"), "USD")
            self.assertEqual(result.get("amountDue"), 123.45)
            self.assertEqual(result.get("amountDueCurrency"), "USD")
        finally:
            service._using_mysql = original_using_mysql
            service._migrate_legacy_links_to_table = original_migrate
            service.patient_links_repository.find_by_token = original_find
            service.patient_links_repository.set_delegate_review_status = original_set_status
            service._audit_event = original_audit

    def test_store_delegate_submission_sends_physician_review_email(self):
        service = self.delegation_service
        original_using_mysql = service._using_mysql
        original_migrate = service._migrate_legacy_links_to_table
        original_find = service.patient_links_repository.find_by_token
        original_store = service.patient_links_repository.store_delegate_payload
        original_audit = service._audit_event
        original_find_user = service.user_repository.find_by_id
        original_send_email = service.email_service.send_delegate_proposal_ready_email
        try:
            service._using_mysql = lambda: True
            service._migrate_legacy_links_to_table = lambda: None
            service.patient_links_repository.find_by_token = lambda *_args, **_kwargs: {
                "doctorId": "doc-1",
                "referenceLabel": "Study Alpha",
                "allowedProducts": ["BPC-157-5MG"],
                "delegateSharedAt": None,
            }
            service.patient_links_repository.store_delegate_payload = lambda *_args, **_kwargs: True
            service._audit_event = lambda *_args, **_kwargs: None
            service.user_repository.find_by_id = lambda doctor_id: {
                "id": doctor_id,
                "name": "Dr. Test",
                "email": "doctor@example.com",
            }

            email_calls = []

            def fake_send_email(recipient, **kwargs):
                email_calls.append((recipient, kwargs))

            service.email_service.send_delegate_proposal_ready_email = fake_send_email

            submitted_at = datetime(2026, 3, 12, 15, 30, tzinfo=timezone.utc)
            service.store_delegate_submission(
                "tok-1",
                cart={"items": [{"name": "BPC-157", "quantity": 1}]},
                shipping={"shippingAddress": {"country": "US"}},
                payment={"paymentMethod": "zelle"},
                order_id="order-1",
                shared_at=submitted_at,
            )

            self.assertEqual(len(email_calls), 1)
            recipient, payload = email_calls[0]
            self.assertEqual(recipient, "doctor@example.com")
            self.assertEqual(payload.get("doctor_name"), "Dr. Test")
            self.assertEqual(payload.get("proposal_label"), "Study Alpha")
            self.assertEqual(payload.get("submitted_at"), submitted_at)
        finally:
            service._using_mysql = original_using_mysql
            service._migrate_legacy_links_to_table = original_migrate
            service.patient_links_repository.find_by_token = original_find
            service.patient_links_repository.store_delegate_payload = original_store
            service._audit_event = original_audit
            service.user_repository.find_by_id = original_find_user
            service.email_service.send_delegate_proposal_ready_email = original_send_email


if __name__ == "__main__":
    unittest.main()
