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

    def test_validate_delegate_items_rejects_scoped_link_without_acl(self):
        service = self.delegation_service
        original_find = service.patient_links_repository.find_by_token
        try:
            service.patient_links_repository.find_by_token = lambda *_args, **_kwargs: {
                "doctorId": "doc-1",
                "productScope": "specific_products",
                "allowedProducts": [],
                "productScopeItems": [],
            }

            with self.assertRaises(ValueError) as ctx:
                service.validate_delegate_items(
                    "abc123",
                    [{"sku": "BPC-157-5MG", "name": "BPC-157", "quantity": 1}],
                )

            self.assertEqual(getattr(ctx.exception, "status", None), 403)
        finally:
            service.patient_links_repository.find_by_token = original_find

    def test_get_doctor_config_caps_markup_at_admin_limit(self):
        service = self.delegation_service
        original_using_mysql = service._using_mysql
        original_migrate = service._migrate_legacy_links_to_table
        original_create = service.patient_links_repository.create_link
        original_audit = service._audit_event
        original_find_user = service.user_repository.find_by_id
        try:
            service._using_mysql = lambda: True
            service._migrate_legacy_links_to_table = lambda: None
            service.user_repository.find_by_id = lambda doctor_id: {
                "id": doctor_id,
                "markupPercent": 37.5,
            }

            config = service.get_doctor_config("doc-1")

            self.assertEqual(config.get("markupPercent"), 20.0)
        finally:
            service._using_mysql = original_using_mysql
            service._migrate_legacy_links_to_table = original_migrate
            service.patient_links_repository.create_link = original_create
            service._audit_event = original_audit
            service.user_repository.find_by_id = original_find_user

    def test_get_doctor_config_defaults_expiry_to_safe_delegate_default(self):
        service = self.delegation_service
        original_using_mysql = service._using_mysql
        original_migrate = service._migrate_legacy_links_to_table
        original_find_user = service.user_repository.find_by_id
        original_get_settings = service.settings_service.get_settings
        try:
            service._using_mysql = lambda: True
            service._migrate_legacy_links_to_table = lambda: None
            service.user_repository.find_by_id = lambda doctor_id: {
                "id": doctor_id,
                "markupPercent": 12.5,
            }
            service.settings_service.get_settings = lambda: {"patientLinkDefaultExpiryHours": 72}

            config = service.get_doctor_config("doc-1")

            self.assertEqual(config.get("defaultExpiryHours"), 72)
        finally:
            service._using_mysql = original_using_mysql
            service._migrate_legacy_links_to_table = original_migrate
            service.user_repository.find_by_id = original_find_user
            service.settings_service.get_settings = original_get_settings

    def test_create_link_caps_explicit_markup_at_admin_limit(self):
        service = self.delegation_service
        original_using_mysql = service._using_mysql
        original_migrate = service._migrate_legacy_links_to_table
        original_create = service.patient_links_repository.create_link
        original_audit = service._audit_event
        try:
            service._using_mysql = lambda: True
            service._migrate_legacy_links_to_table = lambda: None
            captured: dict[str, object] = {}

            def fake_create_link(doctor_id, **kwargs):
                captured["doctor_id"] = doctor_id
                captured["markup_percent"] = kwargs.get("markup_percent")
                return {
                    "token": "tok-1",
                    "markupPercent": kwargs.get("markup_percent"),
                    "allowedProducts": kwargs.get("allowed_products") or [],
                    "expiresAt": None,
                    "usageLimit": kwargs.get("usage_limit"),
                }

            service.patient_links_repository.create_link = fake_create_link
            service._audit_event = lambda *_args, **_kwargs: None

            result = service.create_link(
                "doc-1",
                markup_percent=37.5,
                physician_certified=True,
            )

            self.assertEqual(captured.get("doctor_id"), "doc-1")
            self.assertEqual(captured.get("markup_percent"), 20.0)
            self.assertEqual(result.get("markupPercent"), 20.0)
        finally:
            service._using_mysql = original_using_mysql
            service._migrate_legacy_links_to_table = original_migrate
            service.patient_links_repository.create_link = original_create
            service._audit_event = original_audit

    def test_create_link_defaults_expiry_and_delegate_usage_limit(self):
        service = self.delegation_service
        original_using_mysql = service._using_mysql
        original_migrate = service._migrate_legacy_links_to_table
        original_create = service.patient_links_repository.create_link
        original_audit = service._audit_event
        original_get_settings = service.settings_service.get_settings
        try:
            service._using_mysql = lambda: True
            service._migrate_legacy_links_to_table = lambda: None
            service.settings_service.get_settings = lambda: {"patientLinkDefaultExpiryHours": 72}
            captured: dict[str, object] = {}

            def fake_create_link(doctor_id, **kwargs):
                captured["doctor_id"] = doctor_id
                captured["expires_in_hours"] = kwargs.get("expires_in_hours")
                captured["usage_limit"] = kwargs.get("usage_limit")
                return {
                    "token": "tok-1",
                    "markupPercent": kwargs.get("markup_percent"),
                    "allowedProducts": kwargs.get("allowed_products") or [],
                    "expiresAt": "future",
                    "usageLimit": kwargs.get("usage_limit"),
                }

            service.patient_links_repository.create_link = fake_create_link
            service._audit_event = lambda *_args, **_kwargs: None

            result = service.create_link("doc-1", physician_certified=True)

            self.assertEqual(captured.get("doctor_id"), "doc-1")
            self.assertEqual(captured.get("expires_in_hours"), 72)
            self.assertEqual(captured.get("usage_limit"), 1)
            self.assertEqual(result.get("usageLimit"), 1)
        finally:
            service._using_mysql = original_using_mysql
            service._migrate_legacy_links_to_table = original_migrate
            service.patient_links_repository.create_link = original_create
            service._audit_event = original_audit
            service.settings_service.get_settings = original_get_settings

    def test_create_link_rejects_explicit_non_positive_expiry_and_normalizes_usage_limit(self):
        service = self.delegation_service
        original_using_mysql = service._using_mysql
        original_migrate = service._migrate_legacy_links_to_table
        original_create = service.patient_links_repository.create_link
        original_audit = service._audit_event
        try:
            service._using_mysql = lambda: True
            service._migrate_legacy_links_to_table = lambda: None

            with self.assertRaises(ValueError) as expiry_ctx:
                service.create_link("doc-1", expires_in_hours=0, physician_certified=True)
            self.assertEqual(getattr(expiry_ctx.exception, "status", None), 400)

            service.patient_links_repository.create_link = lambda _doctor_id, **kwargs: {
                "token": "tok-1",
                "usageLimit": kwargs.get("usage_limit"),
            }
            service._audit_event = lambda *_args, **_kwargs: None
            result = service.create_link("doc-1", usage_limit=-1, physician_certified=True)
            self.assertEqual(result.get("usageLimit"), 1)
        finally:
            service._using_mysql = original_using_mysql
            service._migrate_legacy_links_to_table = original_migrate
            service.patient_links_repository.create_link = original_create
            service._audit_event = original_audit

    def test_create_link_passes_hardened_delegate_session_fields(self):
        service = self.delegation_service
        original_using_mysql = service._using_mysql
        original_migrate = service._migrate_legacy_links_to_table
        original_create = service.patient_links_repository.create_link
        original_audit = service._audit_event
        try:
            service._using_mysql = lambda: True
            service._migrate_legacy_links_to_table = lambda: None
            captured: dict[str, object] = {}

            def fake_create_link(doctor_id, **kwargs):
                captured.update(kwargs)
                return {
                    "token": "tok-1",
                    "markupPercent": kwargs.get("markup_percent"),
                    "allowedProducts": kwargs.get("allowed_products") or [],
                    "expiresAt": "future",
                    "usageLimit": kwargs.get("usage_limit"),
                    "productScope": kwargs.get("product_scope"),
                    "delegatePermission": kwargs.get("delegate_permission"),
                }

            service.patient_links_repository.create_link = fake_create_link
            service._audit_event = lambda *_args, **_kwargs: None

            service.create_link(
                "doc-1",
                delegate_name="Delegate A",
                delegate_contact="delegate@example.com",
                delegate_role="caregiver",
                product_scope="specific_products",
                product_scope_items=["bpc-157"],
                delegate_permission="submit_for_physician_review",
                pricing_disclosure="Transparent pricing disclosure.",
                zelle_recipient_name="Dr. Example",
                payment_confirmation_required=True,
                delegate_instructions="Review the product list.",
                internal_physician_note="Internal reference only.",
                terms_version="terms-v1",
                shipping_policy_version="ship-v1",
                privacy_policy_version="privacy-v1",
                physician_certified=True,
            )

            self.assertEqual(captured.get("delegate_name"), "Delegate A")
            self.assertEqual(captured.get("delegate_contact"), "delegate@example.com")
            self.assertEqual(captured.get("delegate_role"), "caregiver")
            self.assertEqual(captured.get("product_scope"), "specific_products")
            self.assertEqual(captured.get("product_scope_items"), ["BPC-157"])
            self.assertEqual(captured.get("delegate_permission"), "submit_for_physician_review")
            self.assertEqual(captured.get("pricing_disclosure"), "Transparent pricing disclosure.")
            self.assertEqual(captured.get("zelle_recipient_name"), "Dr. Example")
            self.assertTrue(captured.get("payment_confirmation_required"))
            self.assertEqual(captured.get("delegate_instructions"), "Review the product list.")
            self.assertEqual(captured.get("internal_physician_note"), "Internal reference only.")
            self.assertEqual(captured.get("terms_version"), "terms-v1")
            self.assertEqual(captured.get("shipping_policy_version"), "ship-v1")
            self.assertEqual(captured.get("privacy_policy_version"), "privacy-v1")
        finally:
            service._using_mysql = original_using_mysql
            service._migrate_legacy_links_to_table = original_migrate
            service.patient_links_repository.create_link = original_create
            service._audit_event = original_audit

    def test_resolve_delegate_token_caps_markup_at_admin_limit(self):
        service = self.delegation_service
        original_using_mysql = service._using_mysql
        original_migrate = service._migrate_legacy_links_to_table
        original_find = service.patient_links_repository.find_by_token
        original_find_user = service.user_repository.find_by_id
        original_touch_last_used = service.patient_links_repository.touch_last_used
        original_audit = service._audit_event
        original_get_settings = service.settings_service.get_settings
        try:
            service._using_mysql = lambda: True
            service._migrate_legacy_links_to_table = lambda: None
            service.patient_links_repository.find_by_token = lambda *_args, **_kwargs: {
                "doctorId": "doc-1",
                "revokedAt": None,
                "status": "active",
                "markupPercent": 37.5,
                "allowedProducts": [],
            }
            service.user_repository.find_by_id = lambda doctor_id: {
                "id": doctor_id,
                "role": "doctor",
                "name": "Dr. Test",
            }
            service.patient_links_repository.touch_last_used = lambda *_args, **_kwargs: None
            service._audit_event = lambda *_args, **_kwargs: None
            service.settings_service.get_settings = lambda: {"patientLinksEnabled": True}

            resolved = service.resolve_delegate_token("tok-1")

            self.assertEqual(resolved.get("markupPercent"), 20.0)
        finally:
            service._using_mysql = original_using_mysql
            service._migrate_legacy_links_to_table = original_migrate
            service.patient_links_repository.find_by_token = original_find
            service.user_repository.find_by_id = original_find_user
            service.patient_links_repository.touch_last_used = original_touch_last_used
            service._audit_event = original_audit
            service.settings_service.get_settings = original_get_settings

    def test_create_brochure_link_forces_view_only_profile(self):
        service = self.delegation_service
        original_using_mysql = service._using_mysql
        original_migrate = service._migrate_legacy_links_to_table
        original_create = service.patient_links_repository.create_link
        original_audit = service._audit_event
        try:
            service._using_mysql = lambda: True
            service._migrate_legacy_links_to_table = lambda: None
            captured: dict[str, object] = {}

            def fake_create_link(doctor_id, **kwargs):
                captured.update(kwargs)
                return {
                    "token": "tok-brochure",
                    "linkType": kwargs.get("link_type"),
                    "capabilities": service.capabilities_for_link_type(kwargs.get("link_type")),
                    "brochureName": kwargs.get("brochure_name"),
                    "recipientName": kwargs.get("delegate_name"),
                    "recipientContact": kwargs.get("delegate_contact"),
                    "delegatePermission": kwargs.get("delegate_permission"),
                    "markupPercent": kwargs.get("markup_percent"),
                    "pricingDisclosure": kwargs.get("pricing_disclosure"),
                    "allowedProducts": kwargs.get("allowed_products") or [],
                    "productScope": kwargs.get("product_scope"),
                    "expiresAt": "future",
                }

            service.patient_links_repository.create_link = fake_create_link
            service._audit_event = lambda *_args, **_kwargs: None

            result = service.create_link(
                "doc-1",
                link_type="brochure",
                brochure_name="Recovery Overview",
                recipient_name="Recipient A",
                recipient_contact="recipient@example.com",
                delegate_permission="submit_for_physician_review",
                markup_percent=35,
                pricing_disclosure="Should be suppressed.",
                payment_method="zelle",
                payment_instructions="Should be suppressed.",
                instructions="Should be suppressed.",
                product_scope="specific_products",
                product_scope_items=["BPC-157"],
                allowed_products=["BPC-157"],
            )

            self.assertEqual(captured.get("link_type"), "brochure")
            self.assertEqual(captured.get("brochure_name"), "Recovery Overview")
            self.assertEqual(result.get("brochureName"), "Recovery Overview")
            self.assertEqual(captured.get("delegate_name"), "Recipient A")
            self.assertEqual(captured.get("delegate_contact"), "recipient@example.com")
            self.assertEqual(captured.get("delegate_permission"), "view_products_only")
            self.assertEqual(captured.get("markup_percent"), 0.0)
            self.assertIsNone(captured.get("pricing_disclosure"))
            self.assertIsNone(captured.get("payment_method"))
            self.assertIsNone(captured.get("payment_instructions"))
            self.assertIsNone(captured.get("instructions"))
            self.assertEqual(result.get("capabilities", {}).get("canViewPricing"), False)
            self.assertEqual(result.get("capabilities", {}).get("canSubmitProposal"), False)
        finally:
            service._using_mysql = original_using_mysql
            service._migrate_legacy_links_to_table = original_migrate
            service.patient_links_repository.create_link = original_create
            service._audit_event = original_audit

    def test_create_brochure_link_requires_name(self):
        service = self.delegation_service
        original_using_mysql = service._using_mysql
        original_migrate = service._migrate_legacy_links_to_table
        try:
            service._using_mysql = lambda: True
            service._migrate_legacy_links_to_table = lambda: None

            with self.assertRaises(ValueError) as ctx:
                service.create_link("doc-1", link_type="brochure", brochure_name="   ")

            self.assertEqual(getattr(ctx.exception, "status", None), 400)
        finally:
            service._using_mysql = original_using_mysql
            service._migrate_legacy_links_to_table = original_migrate

    def test_resolve_delegate_token_can_skip_page_load_count_for_polling(self):
        service = self.delegation_service
        original_using_mysql = service._using_mysql
        original_migrate = service._migrate_legacy_links_to_table
        original_find = service.patient_links_repository.find_by_token
        original_find_user = service.user_repository.find_by_id
        original_touch_last_used = service.patient_links_repository.touch_last_used
        original_audit = service._audit_event
        original_get_settings = service.settings_service.get_settings
        touched = []
        audited = []
        try:
            service._using_mysql = lambda: True
            service._migrate_legacy_links_to_table = lambda: None
            service.patient_links_repository.find_by_token = lambda *_args, **_kwargs: {
                "doctorId": "doc-1",
                "revokedAt": None,
                "status": "active",
                "markupPercent": 15,
                "usageCount": 0,
                "openCount": 4,
                "allowedProducts": [],
            }
            service.user_repository.find_by_id = lambda doctor_id: {
                "id": doctor_id,
                "role": "doctor",
                "name": "Dr. Test",
            }
            service.patient_links_repository.touch_last_used = lambda *args, **kwargs: touched.append((args, kwargs))
            service._audit_event = lambda *args, **kwargs: audited.append((args, kwargs))
            service.settings_service.get_settings = lambda: {"patientLinksEnabled": True}

            resolved = service.resolve_delegate_token("tok-1", count_page_load=False)

            self.assertEqual(resolved.get("openCount"), 4)
            self.assertEqual(touched, [])
            self.assertEqual(audited, [])
        finally:
            service._using_mysql = original_using_mysql
            service._migrate_legacy_links_to_table = original_migrate
            service.patient_links_repository.find_by_token = original_find
            service.user_repository.find_by_id = original_find_user
            service.patient_links_repository.touch_last_used = original_touch_last_used
            service._audit_event = original_audit
            service.settings_service.get_settings = original_get_settings

    def test_resolve_delegate_token_includes_white_label_background_settings(self):
        service = self.delegation_service
        original_using_mysql = service._using_mysql
        original_migrate = service._migrate_legacy_links_to_table
        original_find = service.patient_links_repository.find_by_token
        original_find_user = service.user_repository.find_by_id
        original_touch_last_used = service.patient_links_repository.touch_last_used
        original_audit = service._audit_event
        original_get_settings = service.settings_service.get_settings
        try:
            service._using_mysql = lambda: True
            service._migrate_legacy_links_to_table = lambda: None
            service.patient_links_repository.find_by_token = lambda *_args, **_kwargs: {
                "doctorId": "doc-1",
                "revokedAt": None,
                "status": "active",
                "markupPercent": 15,
                "allowedProducts": [],
            }
            service.user_repository.find_by_id = lambda doctor_id: {
                "id": doctor_id,
                "role": "doctor",
                "name": "Dr. Test",
                "delegateLogoUrl": "data:image/png;base64,LOGO",
                "delegateSecondaryColor": "#0b0679",
                "delegateBackgroundImageUrl": "data:image/jpeg;base64,BACKGROUND",
                "delegateBackgroundColor": "#edf7fb",
            }
            service.patient_links_repository.touch_last_used = lambda *_args, **_kwargs: None
            service._audit_event = lambda *_args, **_kwargs: None
            service.settings_service.get_settings = lambda: {"patientLinksEnabled": True}

            resolved = service.resolve_delegate_token("tok-1")

            self.assertEqual(resolved.get("doctorLogoUrl"), "data:image/png;base64,LOGO")
            self.assertEqual(resolved.get("doctorSecondaryColor"), "#0b0679")
            self.assertEqual(resolved.get("doctorBackgroundImageUrl"), "data:image/jpeg;base64,BACKGROUND")
            self.assertEqual(resolved.get("doctorBackgroundColor"), "#edf7fb")
        finally:
            service._using_mysql = original_using_mysql
            service._migrate_legacy_links_to_table = original_migrate
            service.patient_links_repository.find_by_token = original_find
            service.user_repository.find_by_id = original_find_user
            service.patient_links_repository.touch_last_used = original_touch_last_used
            service._audit_event = original_audit
            service.settings_service.get_settings = original_get_settings

    def test_resolve_brochure_token_returns_privacy_safe_view_only_profile(self):
        service = self.delegation_service
        original_using_mysql = service._using_mysql
        original_migrate = service._migrate_legacy_links_to_table
        original_find = service.patient_links_repository.find_by_token
        original_find_user = service.user_repository.find_by_id
        original_touch_last_used = service.patient_links_repository.touch_last_used
        original_audit = service._audit_event
        original_get_settings = service.settings_service.get_settings
        touched = []
        try:
            service._using_mysql = lambda: True
            service._migrate_legacy_links_to_table = lambda: None
            service.patient_links_repository.find_by_token = lambda *_args, **_kwargs: {
                "token": "tok-brochure",
                "doctorId": "doc-1",
                "linkType": "brochure",
                "revokedAt": None,
                "status": "active",
                "markupPercent": 45,
                "brochureName": "Recovery Overview",
                "allowedProducts": ["BPC-157"],
                "subjectLabel": "Subject A",
                "studyLabel": "Study A",
                "patientReference": "Internal Ref",
                "delegateName": "Delegate A",
                "delegateRole": "caregiver",
                "delegatePermission": "submit_for_physician_review",
                "pricingDisclosure": "Private price disclosure.",
                "paymentConfirmationRequired": True,
                "delegateInstructions": "Private instructions.",
                "paymentMethod": "zelle",
                "paymentInstructions": "Private payment instructions.",
                "instructions": "Private brochure instructions.",
                "delegateSharedAt": "2026-05-21T12:00:00+00:00",
                "delegateOrderId": "order-1",
                "delegateReviewStatus": "pending",
                "delegateReviewedAt": "2026-05-21T12:05:00+00:00",
                "delegateReviewOrderId": "order-2",
                "delegateReviewNotes": "Private notes.",
                "openCount": 2,
                "viewCount": 2,
            }
            service.user_repository.find_by_id = lambda doctor_id: {
                "id": doctor_id,
                "role": "doctor",
                "name": "Dr. Test",
                "delegateLogoUrl": "data:image/png;base64,LOGO",
                "delegateSecondaryColor": "#0b0679",
                "delegateBackgroundImageUrl": "data:image/jpeg;base64,BACKGROUND",
                "delegateBackgroundColor": "#edf7fb",
            }
            service.patient_links_repository.touch_last_used = lambda *args, **kwargs: touched.append((args, kwargs))
            service._audit_event = lambda *_args, **_kwargs: None
            service.settings_service.get_settings = lambda: {"patientLinksEnabled": True}

            resolved = service.resolve_delegate_token(
                "tok-brochure",
                count_page_load=True,
                view_context={"ip": "203.0.113.8", "userAgent": "UnitTestBrowser/1.0"},
            )

            self.assertEqual(resolved.get("linkType"), "brochure")
            self.assertEqual(resolved.get("doctorId"), "")
            self.assertEqual(resolved.get("doctorName"), "Dr. Test")
            self.assertEqual(resolved.get("doctorLogoUrl"), "data:image/png;base64,LOGO")
            self.assertEqual(resolved.get("doctorBackgroundImageUrl"), "data:image/jpeg;base64,BACKGROUND")
            self.assertEqual(resolved.get("capabilities", {}).get("canViewProducts"), True)
            self.assertEqual(resolved.get("capabilities", {}).get("canViewPricing"), False)
            self.assertEqual(resolved.get("capabilities", {}).get("canAddToCart"), False)
            self.assertEqual(resolved.get("capabilities", {}).get("canCheckout"), False)
            self.assertEqual(resolved.get("capabilities", {}).get("canSubmitProposal"), False)
            self.assertEqual(resolved.get("capabilities", {}).get("canViewCOA"), True)
            self.assertEqual(resolved.get("capabilities", {}).get("canViewInventory"), False)
            self.assertEqual(resolved.get("markupPercent"), 0.0)
            self.assertIsNone(resolved.get("subjectLabel"))
            self.assertIsNone(resolved.get("studyLabel"))
            self.assertIsNone(resolved.get("patientReference"))
            self.assertIsNone(resolved.get("brochureName"))
            self.assertIsNone(resolved.get("brochure_name"))
            self.assertEqual(resolved.get("brochureTitle"), "Recovery Overview")
            self.assertEqual(resolved.get("pageTitle"), "Recovery Overview")
            self.assertIsNone(resolved.get("delegateName"))
            self.assertIsNone(resolved.get("delegateRole"))
            self.assertEqual(resolved.get("delegatePermission"), "view_products_only")
            self.assertEqual(resolved.get("allowedProducts"), [])
            self.assertEqual(resolved.get("productScopeItems"), [])
            self.assertIsNone(resolved.get("pricingDisclosure"))
            self.assertFalse(resolved.get("paymentConfirmationRequired"))
            self.assertIsNone(resolved.get("delegateInstructions"))
            self.assertIsNone(resolved.get("paymentMethod"))
            self.assertIsNone(resolved.get("paymentInstructions"))
            self.assertIsNone(resolved.get("instructions"))
            self.assertIsNone(resolved.get("delegateSharedAt"))
            self.assertIsNone(resolved.get("delegateOrderId"))
            self.assertIsNone(resolved.get("proposalStatus"))
            self.assertIsNone(resolved.get("proposalReviewedAt"))
            self.assertIsNone(resolved.get("proposalReviewOrderId"))
            self.assertIsNone(resolved.get("proposalReviewNotes"))
            self.assertIsNone(resolved.get("compensationDisclosure"))
            self.assertFalse(
                any("compensation" in str(disclosure).lower() for disclosure in resolved.get("disclosures") or [])
            )
            self.assertEqual(resolved.get("openCount"), 3)
            self.assertEqual(resolved.get("viewCount"), 3)
            self.assertEqual(len(touched), 1)
            self.assertEqual(touched[0][0], ("tok-brochure",))
            self.assertNotEqual(touched[0][1].get("ip_hash"), "203.0.113.8")
            self.assertNotEqual(touched[0][1].get("user_agent_hash"), "UnitTestBrowser/1.0")
            self.assertEqual(len(touched[0][1].get("ip_hash") or ""), 64)
            self.assertEqual(len(touched[0][1].get("user_agent_hash") or ""), 64)
        finally:
            service._using_mysql = original_using_mysql
            service._migrate_legacy_links_to_table = original_migrate
            service.patient_links_repository.find_by_token = original_find
            service.user_repository.find_by_id = original_find_user
            service.patient_links_repository.touch_last_used = original_touch_last_used
            service._audit_event = original_audit
            service.settings_service.get_settings = original_get_settings

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
            find_state = {"stored": False}

            def fake_find_by_token(*_args, **_kwargs):
                return {
                    "doctorId": "doc-1",
                    "referenceLabel": "Study Alpha",
                    "allowedProducts": ["BPC-157-5MG"],
                    "delegateSharedAt": "2026-03-12T15:30:00+00:00" if find_state["stored"] else None,
                    "delegateReviewStatus": "pending" if find_state["stored"] else None,
                }

            def fake_store_delegate_payload(*_args, **_kwargs):
                find_state["stored"] = True
                return True

            service.patient_links_repository.find_by_token = fake_find_by_token
            service.patient_links_repository.store_delegate_payload = fake_store_delegate_payload
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

    def test_store_delegate_submission_sends_email_from_persisted_pending_state(self):
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
            find_state = {"stored": False}

            def fake_find_by_token(*_args, **_kwargs):
                if not find_state["stored"]:
                    return {
                        "doctorId": "doc-1",
                        "linkType": "delegate",
                        "usageCount": 0,
                        "usageLimit": 1,
                    }
                return {
                    "doctorId": "doc-1",
                    "linkType": "delegate",
                    "subjectLabel": "Subject A",
                    "delegateSharedAt": "2026-03-12T15:30:00+00:00",
                    "delegateReviewStatus": "pending",
                }

            def fake_store_delegate_payload(*_args, **_kwargs):
                find_state["stored"] = True
                return True

            service.patient_links_repository.find_by_token = fake_find_by_token
            service.patient_links_repository.store_delegate_payload = fake_store_delegate_payload
            service._audit_event = lambda *_args, **_kwargs: None
            service.user_repository.find_by_id = lambda doctor_id: {
                "id": doctor_id,
                "name": "Dr. Test",
                "email": "doctor@example.com",
            }

            email_calls = []
            service.email_service.send_delegate_proposal_ready_email = (
                lambda recipient, **kwargs: email_calls.append((recipient, kwargs))
            )

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
            self.assertEqual(payload.get("proposal_label"), "Subject A")
            self.assertEqual(payload.get("submitted_at"), submitted_at)
        finally:
            service._using_mysql = original_using_mysql
            service._migrate_legacy_links_to_table = original_migrate
            service.patient_links_repository.find_by_token = original_find
            service.patient_links_repository.store_delegate_payload = original_store
            service._audit_event = original_audit
            service.user_repository.find_by_id = original_find_user
            service.email_service.send_delegate_proposal_ready_email = original_send_email

    def test_store_delegate_submission_respects_physician_email_preference(self):
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
                "delegateSharedAt": "2026-03-12T15:30:00+00:00",
                "delegateReviewStatus": "pending",
            }
            service.patient_links_repository.store_delegate_payload = lambda *_args, **_kwargs: True
            service._audit_event = lambda *_args, **_kwargs: None
            service.user_repository.find_by_id = lambda doctor_id: {
                "id": doctor_id,
                "name": "Dr. Test",
                "email": "doctor@example.com",
                "receivePatientLinkUpdateEmails": False,
            }

            email_calls = []
            service.email_service.send_delegate_proposal_ready_email = (
                lambda recipient, **kwargs: email_calls.append((recipient, kwargs))
            )

            service.store_delegate_submission(
                "tok-1",
                cart={"items": [{"name": "BPC-157", "quantity": 1}]},
                shipping={"shippingAddress": {"country": "US"}},
                payment={"paymentMethod": "zelle"},
                order_id="order-1",
                shared_at=datetime(2026, 3, 12, 15, 30, tzinfo=timezone.utc),
            )

            self.assertEqual(email_calls, [])
        finally:
            service._using_mysql = original_using_mysql
            service._migrate_legacy_links_to_table = original_migrate
            service.patient_links_repository.find_by_token = original_find
            service.patient_links_repository.store_delegate_payload = original_store
            service._audit_event = original_audit
            service.user_repository.find_by_id = original_find_user
            service.email_service.send_delegate_proposal_ready_email = original_send_email

    def test_store_delegate_submission_rejects_exhausted_usage_limit_before_store(self):
        service = self.delegation_service
        original_using_mysql = service._using_mysql
        original_migrate = service._migrate_legacy_links_to_table
        original_find = service.patient_links_repository.find_by_token
        original_store = service.patient_links_repository.store_delegate_payload
        try:
            service._using_mysql = lambda: True
            service._migrate_legacy_links_to_table = lambda: None
            find_calls = []

            def fake_find_by_token(*args, **kwargs):
                find_calls.append((args, kwargs))
                return {
                    "doctorId": "doc-1",
                    "linkType": "delegate",
                    "usageLimit": 1,
                    "usageCount": 1,
                }

            service.patient_links_repository.find_by_token = fake_find_by_token
            service.patient_links_repository.store_delegate_payload = lambda *_args, **_kwargs: self.fail(
                "store_delegate_payload should not be called for exhausted delegate links"
            )

            with self.assertRaises(ValueError) as ctx:
                service.store_delegate_submission(
                    "tok-1",
                    cart={"items": [{"name": "BPC-157", "quantity": 1}]},
                    shipping={"shippingAddress": {"country": "US"}},
                    payment={"paymentMethod": "zelle"},
                    order_id="order-1",
                    shared_at=datetime(2026, 3, 12, 15, 30, tzinfo=timezone.utc),
                )

            self.assertEqual(getattr(ctx.exception, "status", None), 403)
            self.assertTrue(find_calls)
            self.assertNotEqual(find_calls[0][1].get("include_inactive"), True)
        finally:
            service._using_mysql = original_using_mysql
            service._migrate_legacy_links_to_table = original_migrate
            service.patient_links_repository.find_by_token = original_find
            service.patient_links_repository.store_delegate_payload = original_store

    def test_resolve_delegate_token_rejects_expired_link(self):
        service = self.delegation_service
        original_using_mysql = service._using_mysql
        original_migrate = service._migrate_legacy_links_to_table
        original_find = service.patient_links_repository.find_by_token
        try:
            service._using_mysql = lambda: True
            service._migrate_legacy_links_to_table = lambda: None
            service.patient_links_repository.find_by_token = lambda *_args, **_kwargs: {
                "doctorId": "doc-1",
                "revokedAt": None,
                "status": "expired",
            }

            with self.assertRaises(ValueError) as ctx:
                service.resolve_delegate_token("tok-expired")

            self.assertEqual(getattr(ctx.exception, "status", None), 404)
        finally:
            service._using_mysql = original_using_mysql
            service._migrate_legacy_links_to_table = original_migrate
            service.patient_links_repository.find_by_token = original_find


if __name__ == "__main__":
    unittest.main()
