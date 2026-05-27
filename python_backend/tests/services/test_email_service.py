import unittest
from types import SimpleNamespace
from unittest.mock import patch


class EmailServiceTests(unittest.TestCase):
    def test_shipping_status_email_bccs_pgibbons_trufusionlabs(self):
        from python_backend.services import email_service

        with patch.object(
            email_service,
            "get_config",
            return_value=SimpleNamespace(frontend_base_url="https://trufusionlabs.com"),
        ), patch.object(email_service, "_dispatch_email") as dispatch_email:
            email_service.send_order_shipping_status_email(
                "holly@example.com",
                status="shipped",
                customer_name="Holly O'Quin",
                order_number="1505",
                tracking_number="1ZSHIP1505",
                carrier_code="ups",
            )

        dispatch_email.assert_called_once()
        self.assertEqual(dispatch_email.call_args.args[0], "holly@example.com")
        html = dispatch_email.call_args.args[2]
        self.assertIn('src="cid:trufusion-logo"', html)
        self.assertIn("trufusion-email-template:shipping-status-v2", html)
        self.assertIn('width="360"', html)
        self.assertIn("width:360px", html)
        self.assertIn("max-width:70%", html)
        self.assertNotIn("width:100%", html)
        self.assertIn("background-color:#ffffff;", html)
        self.assertIn("background:#ffffff;", html)
        self.assertIn("background-image:none;", html)
        self.assertIn("background-image:linear-gradient(#ffffff,#ffffff)", html)
        self.assertNotIn('background="cid:trufusion-leaf"', html)
        self.assertNotIn("url('cid:trufusion-leaf')", html)
        self.assertIn("min-height:100vh", html)
        self.assertIn("height:100vh", html)
        self.assertIn('class="trufusion-email-card"', html)
        self.assertNotIn("background:rgba(255,255,255,0.64)", html)
        self.assertNotIn("backdrop-filter", html)
        self.assertIn('td align="center" style="padding:0 14px;"', html)
        self.assertIn("<strong>Order: 1505</strong>", html)
        self.assertIn("<strong>Tracking: 1ZSHIP1505</strong>", html)
        self.assertNotIn("UPS tracking", html)
        self.assertIn('class="trufusion-button trufusion-track-button"', html)
        self.assertIn(".trufusion-track-button:hover", html)
        self.assertIn("background-color:#0B0679", html)
        self.assertIn("background-color:#0B0679 !important", html)
        self.assertIn("background-image:linear-gradient(#0B0679,#0B0679)", html)
        self.assertIn("color:#ffffff !important", html)
        self.assertIn("-webkit-text-fill-color:#ffffff", html)
        self.assertIn('href="https://trufusionlabs.com"', html)
        self.assertIn(">trufusionlabs.com</a>", html)
        self.assertIn("Sign in to your account", dispatch_email.call_args.args[3])
        self.assertNotIn("background-color:rgba(255,255,255,0.95)", html)
        self.assertNotIn("border:2px solid rgb(11,6,121)", html)
        self.assertIn("border-radius:12px", html)
        self.assertNotIn("border-radius:999px", html)
        self.assertNotIn("https://trufusionlabs.com/turfusionlabsphysiciansportal.png", html)
        self.assertNotIn("https://trufusionlabs.com/leafTexture.jpg", html)
        self.assertNotIn("/turfusionlabsphysiciansportal.png", html)
        self.assertEqual(dispatch_email.call_args.kwargs["bcc"], ("pgibbons@trufusionlabs.com",))
        self.assertEqual(
            dispatch_email.call_args.kwargs["headers"],
            {
                "X-Trufusion-Email-Template": "shipping-status-v2",
                "X-Trufusion-Email-Renderer": "python_backend.services.email_service",
            },
        )
        self.assertTrue(dispatch_email.call_args.kwargs["raise_on_failure"])
        self.assertNotIn("cc", dispatch_email.call_args.kwargs)

    def test_all_shipping_status_update_emails_bcc_pgibbons_trufusionlabs(self):
        from python_backend.services import email_service

        statuses = ("shipped", "in_transit", "out_for_delivery", "delivered")
        with patch.object(
            email_service,
            "get_config",
            return_value=SimpleNamespace(frontend_base_url="https://trufusionlabs.com"),
        ), patch.object(email_service, "_dispatch_email") as dispatch_email:
            for status in statuses:
                email_service.send_order_shipping_status_email(
                    "holly@example.com",
                    status=status,
                    customer_name="Holly O'Quin",
                    order_number="1505",
                    tracking_number="1ZSHIP1505",
                    carrier_code="ups",
                )

        self.assertEqual(dispatch_email.call_count, len(statuses))
        for call in dispatch_email.call_args_list:
            self.assertEqual(call.kwargs["bcc"], ("pgibbons@trufusionlabs.com",))
            self.assertEqual(call.kwargs["headers"]["X-Trufusion-Email-Template"], "shipping-status-v2")
            self.assertTrue(call.kwargs["raise_on_failure"])

    def test_shipping_status_email_uses_in_transit_copy(self):
        from python_backend.services import email_service

        with patch.object(
            email_service,
            "get_config",
            return_value=SimpleNamespace(frontend_base_url="https://trufusionlabs.com"),
        ), patch.object(email_service, "_dispatch_email") as dispatch_email:
            email_service.send_order_shipping_status_email(
                "holly@example.com",
                status="in_transit",
                customer_name="Holly O'Quin",
                order_number="1505",
                tracking_number="1ZSHIP1505",
                carrier_code="ups",
                delivery_label="Tuesday, April 7, 2026",
            )

        dispatch_email.assert_called_once()
        self.assertEqual(dispatch_email.call_args.args[1], "TrufusionLabs order 1505 is in transit")
        html = dispatch_email.call_args.args[2]
        plain = dispatch_email.call_args.args[3]
        self.assertIn("Your TrufusionLabs order is in transit", html)
        self.assertIn("Your package is moving through the carrier network.", html)
        self.assertIn("<strong>Estimated delivery: Tuesday, April 7, 2026</strong>", html)
        self.assertLess(
            html.find("<strong>Estimated delivery: Tuesday, April 7, 2026</strong>"),
            html.find("<strong>Tracking: 1ZSHIP1505</strong>"),
        )
        self.assertLess(
            html.find("<strong>Tracking: 1ZSHIP1505</strong>"),
            html.find("<strong>Order: 1505</strong>"),
        )
        self.assertIn("Your TrufusionLabs order is in transit", plain)
        self.assertIn("Estimated delivery: Tuesday, April 7, 2026", plain)
        self.assertLess(
            plain.find("Estimated delivery: Tuesday, April 7, 2026"),
            plain.find("Tracking: 1ZSHIP1505"),
        )
        self.assertLess(plain.find("Tracking: 1ZSHIP1505"), plain.find("Order: 1505"))

    def test_shipping_status_email_includes_facility_pickup_method(self):
        from python_backend.services import email_service

        subject, html, plain = email_service._build_shipping_status_email(
            customer_name="Marcus Barrera",
            order_number="1615",
            status="shipped",
            tracking_number=None,
            carrier_code="facility_pickup",
            delivery_label=None,
            base_url="https://trufusionlabs.com",
            fulfillment_label="Facility Pickup",
        )

        self.assertEqual(subject, "TrufusionLabs order 1615 has shipped")
        self.assertIn("<strong>Delivery method: Facility Pickup</strong>", html)
        self.assertIn("<strong>Order: 1615</strong>", html)
        self.assertLess(
            html.find("<strong>Delivery method: Facility Pickup</strong>"),
            html.find("<strong>Order: 1615</strong>"),
        )
        self.assertNotIn("Tracking:", html)
        self.assertNotIn(">Track Package</a>", html)
        self.assertIn("Delivery method: Facility Pickup", plain)
        self.assertLess(
            plain.find("Delivery method: Facility Pickup"),
            plain.find("Order: 1615"),
        )

    def test_email_settings_normalizes_trufusionlabs_sender_name(self):
        from python_backend.services import email_service

        with patch.dict("os.environ", {"MAIL_FROM": '"TrufusionLabs" <support@trufusionlabs.com>'}):
            settings = email_service._email_settings()

        self.assertEqual(settings["from"], '"TrufusionLabs" <support@trufusionlabs.com>')

    def test_email_settings_replaces_legacy_peppro_support_sender(self):
        from python_backend.services import email_service

        with patch.dict("os.environ", {"MAIL_FROM": "PepPro <support@peppro.net>"}):
            settings = email_service._email_settings()

        self.assertEqual(settings["from"], "TrufusionLabs <support@trufusionlabs.com>")

    def test_email_settings_honors_smtp_secure_ssl_alias(self):
        from python_backend.services import email_service

        env = {"SMTP_HOST": "smtp.example.com", "SMTP_PORT": "465", "SMTP_SECURE": "true"}
        with patch.dict("os.environ", env, clear=True):
            settings = email_service._email_settings()

        self.assertEqual(settings["smtp"]["port"], 465)
        self.assertTrue(settings["smtp"]["ssl"])
        self.assertFalse(settings["smtp"]["starttls"])

    def test_email_settings_honors_smtp_secure_starttls_alias(self):
        from python_backend.services import email_service

        env = {"SMTP_HOST": "smtp.example.com", "SMTP_PORT": "587", "SMTP_SECURE": "tls"}
        with patch.dict("os.environ", env, clear=True):
            settings = email_service._email_settings()

        self.assertEqual(settings["smtp"]["port"], 587)
        self.assertFalse(settings["smtp"]["ssl"])
        self.assertTrue(settings["smtp"]["starttls"])

    def test_generated_email_templates_use_shared_solid_background(self):
        from python_backend.services import email_service

        templates = [
            email_service._build_email_verification_email(
                "123456",
                "https://trufusionlabs.com",
            )[0],
            email_service._build_contact_form_received_email(
                name="Dr. Test",
                base_url="https://trufusionlabs.com",
            )[0],
            email_service._build_password_reset_email(
                "https://trufusionlabs.com/reset-password?token=test",
                "https://trufusionlabs.com",
            )[0],
            email_service._build_delegate_proposal_ready_email(
                doctor_name="Dr. Test",
                proposal_label="Proposal",
                submitted_at_label="Just now",
                base_url="https://trufusionlabs.com",
            )[0],
            email_service._build_delegate_links_beta_info_email(base_url="https://trufusionlabs.com")[0],
            email_service._build_shipping_status_email(
                customer_name="Holly",
                order_number="1505",
                status="shipped",
                tracking_number="1ZSHIP1505",
                carrier_code="ups",
                delivery_label=None,
                base_url="https://trufusionlabs.com",
            )[1],
        ]

        for html in templates:
            self.assertIn("background-color:#ffffff;", html)
            self.assertIn("background:#ffffff;", html)
            self.assertIn("background-image:linear-gradient(#ffffff,#ffffff)", html)
            self.assertTrue("trufusion-email-card" in html or "trufusion-contact-card" in html)
            if 'class="trufusion-contact-card"' in html:
                self.assertIn("background-image:linear-gradient(#ffffff,#ffffff);", html)
                self.assertIn("-webkit-text-fill-color:#111827", html)
                self.assertIn("trufusion-email-shell", html)
                self.assertIn("padding:32px 16px", html)
            else:
                self.assertIn("background-image:none;", html)
            self.assertIn('src="cid:trufusion-logo"', html)
            self.assertNotIn("TrufusionLabs_PhysiciansPortal.png", html)
            self.assertNotIn("border-radius:999px", html)
            self.assertNotIn("cid:trufusion-leaf", html)
            self.assertNotIn("leafTexture", html)

        logo_spec = next(
            spec for spec in email_service._EMAIL_INLINE_IMAGE_SPECS if spec["content_id"] == "trufusion-logo"
        )

        self.assertEqual(logo_spec["filename"], "FullLogo_Transparent_NoBuffer (18).png")

    def test_email_verification_email_forces_support_sender(self):
        from python_backend.services import email_service

        with patch.object(
            email_service,
            "get_config",
            return_value=SimpleNamespace(frontend_base_url="https://trufusionlabs.com"),
        ), patch.object(email_service, "_dispatch_email") as dispatch_email:
            email_service.send_email_verification_email(
                "doctor@example.com",
                "123456",
            )

        dispatch_email.assert_called_once()
        self.assertEqual(dispatch_email.call_args.args[0], "doctor@example.com")
        self.assertEqual(dispatch_email.call_args.args[1], "Verify your TrufusionLabs account")
        self.assertIn("Verify your TrufusionLabs account", dispatch_email.call_args.args[2])
        self.assertIn("123456", dispatch_email.call_args.args[2])
        self.assertIn('src="cid:trufusion-logo"', dispatch_email.call_args.args[2])
        self.assertIn("Your verification code is: 123456", dispatch_email.call_args.args[3])
        self.assertEqual(
            dispatch_email.call_args.kwargs["from_address"],
            "TrufusionLabs <support@trufusionlabs.com>",
        )
        self.assertEqual(dispatch_email.call_args.kwargs["reply_to"], "support@trufusionlabs.com")
        self.assertTrue(dispatch_email.call_args.kwargs["raise_on_failure"])
        self.assertTrue(dispatch_email.call_args.kwargs["enforce_trufusion_sender"])

    def test_contact_form_received_email_confirms_submission(self):
        from python_backend.services import email_service

        with patch.object(
            email_service,
            "get_config",
            return_value=SimpleNamespace(frontend_base_url="https://trufusionlabs.com"),
        ), patch.object(email_service, "_dispatch_email") as dispatch_email:
            email_service.send_contact_form_received_email(
                "doctor@example.com",
                name="Dr. Jane Example",
            )

        dispatch_email.assert_called_once()
        self.assertEqual(dispatch_email.call_args.args[0], "doctor@example.com")
        self.assertEqual(dispatch_email.call_args.args[1], "We received your TrufusionLabs contact request")
        self.assertIn("We received your request", dispatch_email.call_args.args[2])
        self.assertIn("Dr. Jane Example", dispatch_email.call_args.args[2])
        self.assertIn("representative will review it shortly", dispatch_email.call_args.args[2])
        self.assertIn('src="cid:trufusion-logo"', dispatch_email.call_args.args[2])
        self.assertIn("trufusion-contact-card", dispatch_email.call_args.args[2])
        self.assertIn("background-image:linear-gradient(#0B0679,#0B0679)", dispatch_email.call_args.args[2])
        self.assertIn("-webkit-text-fill-color:#ffffff", dispatch_email.call_args.args[2])
        self.assertIn("border-radius:12px", dispatch_email.call_args.args[2])
        self.assertNotIn("border-radius:999px", dispatch_email.call_args.args[2])
        self.assertIn("We received your contact form submission", dispatch_email.call_args.args[3])
        self.assertEqual(
            dispatch_email.call_args.kwargs["from_address"],
            "TrufusionLabs <support@trufusionlabs.com>",
        )
        self.assertEqual(dispatch_email.call_args.kwargs["cc"], ("support@trufusionlabs.com",))
        self.assertEqual(dispatch_email.call_args.kwargs["reply_to"], "support@trufusionlabs.com")
        self.assertNotIn("raise_on_failure", dispatch_email.call_args.kwargs)

    def test_delegate_links_beta_info_email_describes_delegate_links(self):
        from python_backend.services import email_service

        html, plain = email_service._build_delegate_links_beta_info_email(base_url="https://trufusionlabs.com")

        self.assertIn("Welcome to Delegate Links", html)
        self.assertIn("SERVICE AVAILABLE", html)
        self.assertIn("Delegate Links: Extending Physician Reach", html)
        self.assertIn("Distribute and manage white-labeled research material sessions.", html)
        self.assertIn("trusted delegate needs to submit selections for physician review", html)
        self.assertIn("Brochure", html)
        self.assertIn("Proposal", html)
        self.assertIn('src="cid:delegate-links-proposal-session"', html)
        self.assertIn('src="cid:delegate-links-create-dialog"', html)
        self.assertIn("Delegate proposal session with branded catalog and product cards", html)
        self.assertIn("Create link dialog showing Brochure and Proposal link options", html)
        self.assertIn("Create and track your brochures and proposal sessions", html)
        self.assertIn("Setup white-labeled sessions for your clients.", html)
        self.assertIn("text-align:left", html)
        self.assertLess(
            html.index("Create and track your brochures and proposal sessions"),
            html.index('src="cid:delegate-links-create-dialog"'),
        )
        self.assertLess(
            html.index("Setup white-labeled sessions for your clients."),
            html.index('src="cid:delegate-links-proposal-session"'),
        )
        self.assertLess(
            html.index('src="cid:delegate-links-create-dialog"'),
            html.index('src="cid:delegate-links-proposal-session"'),
        )
        self.assertIn("font-size:30px", html)
        self.assertIn("font-weight:700", html)
        self.assertIn("width:1%;padding:0 4px 16px 0", html)
        self.assertIn("color:#0B0679;-webkit-text-fill-color:#0B0679", html)
        self.assertIn("vertical-align:top;text-align:right;white-space:nowrap", html)
        self.assertIn('role="presentation" align="center" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:100%;margin:0 auto;border-collapse:collapse;"', html)
        self.assertIn(">1.</td>", html)
        self.assertIn(">2.</td>", html)
        self.assertIn(">3.</td>", html)
        self.assertIn(">4.</td>", html)
        self.assertIn('Go to your physician dashboard and see the "Delegate Links" tab.', html)
        self.assertIn('Click "Create a link" and choose your link type.', html)
        self.assertIn("Define the link parameters and send the link to your client.", html)
        self.assertIn("Manage your links with preview, copy, track, revoke, and review controls.", html)
        self.assertNotIn("<strong style=\"color:#111827;\">Open Delegate Links</strong>", html)
        self.assertNotIn("Set up your brand: add your logo and primary color in Account > Delegate Links Beta.", html)
        self.assertNotIn("Welcome to the Delegate Links Beta", html)
        self.assertNotIn(">Delegate Links</p>", html)
        self.assertNotIn("M12 6.042", html)
        self.assertNotIn("What kind of link would you like to create?</td>", html)
        self.assertIn("Open Delegate Links", html)
        self.assertIn("How to use Delegate Links", plain)
        self.assertIn('1. Go to your physician dashboard and see the "Delegate Links" tab.', plain)
        self.assertIn('2. Click "Create a link" and choose your link type.', plain)
        self.assertIn("3. Define the link parameters and send the link to your client.", plain)
        self.assertIn("4. Manage your links with preview, copy, track, revoke, and review controls.", plain)
        self.assertNotIn("Patient Links", html)
        self.assertNotIn("patient-links", html)
        self.assertNotIn("Product Brochure", html)
        self.assertNotIn("Delegate: create a patient session", plain)

    def test_smtp_relay_can_skip_login_when_auth_disabled(self):
        from python_backend.services import email_service

        events = []
        messages = []

        class FakeSMTP:
            def __init__(self, host, port, timeout):
                events.append(("connect", host, port, timeout))

            def ehlo(self):
                events.append(("ehlo",))

            def starttls(self):
                events.append(("starttls",))

            def login(self, user, password):
                events.append(("login", user, password))

            def send_message(self, msg, from_addr=None, to_addrs=None):
                messages.append(msg)
                events.append(("send_message", from_addr, msg["To"], msg["Cc"], tuple(to_addrs or ())))

            def quit(self):
                events.append(("quit",))

        inline_images = (
            {
                "content_id": "trufusion-logo",
                "filename": "FullLogo_Transparent_NoBuffer (18).png",
                "mime_type": "image/png",
                "maintype": "image",
                "subtype": "png",
                "data": b"logo",
            },
            {
                "content_id": "trufusion-leaf",
                "filename": "leafTexture.jpg",
                "mime_type": "image/jpeg",
                "maintype": "image",
                "subtype": "jpeg",
                "data": b"leaf",
            },
        )

        with patch.object(email_service, "_load_inline_email_images", return_value=inline_images), patch.object(
            email_service.smtplib,
            "SMTP",
            FakeSMTP,
        ):
            email_service._send_via_smtp(
                "holly@example.com",
                "TrufusionLabs order 1505 has shipped",
                '<img src="cid:trufusion-logo" /><table background="cid:trufusion-leaf"></table>',
                {
                    "from": "TrufusionLabs <support@trufusionlabs.com>",
                    "timeout": 15,
                    "smtp": {
                        "host": "smtp-relay.gmail.com",
                        "port": 587,
                        "ssl": False,
                        "starttls": True,
                        "auth": False,
                    },
                },
                plain_text="Shipped",
                cc=("petergibbons7@icloud.com",),
                bcc=("finance@example.com",),
                reply_to="support@trufusionlabs.com",
                headers={"X-Trufusion-Email-Template": "shipping-status-v2"},
            )

        self.assertIn(("connect", "smtp-relay.gmail.com", 587, 15), events)
        self.assertIn(("starttls",), events)
        self.assertNotIn(("login", "support@trufusionlabs.com", ""), events)
        self.assertIn(
            (
                "send_message",
                "support@trufusionlabs.com",
                "holly@example.com",
                "petergibbons7@icloud.com",
                ("holly@example.com", "petergibbons7@icloud.com", "finance@example.com"),
            ),
            events,
        )
        self.assertEqual(messages[0]["Reply-To"], "support@trufusionlabs.com")
        self.assertEqual(messages[0]["X-Trufusion-Email-Template"], "shipping-status-v2")
        self.assertEqual(messages[0]["Auto-Submitted"], "auto-generated")
        self.assertTrue(messages[0]["Message-ID"].endswith("@trufusionlabs.com>"))
        self.assertNotIn("finance@example.com", messages[0].as_string())
        content_ids = [part["Content-ID"] for part in messages[0].walk() if part["Content-ID"]]
        self.assertEqual(content_ids, ["<trufusion-logo>", "<trufusion-leaf>"])

    def test_email_verification_refuses_legacy_peppro_smtp_user(self):
        from python_backend.services import email_service

        with patch.object(
            email_service,
            "get_config",
            return_value=SimpleNamespace(frontend_base_url="https://trufusionlabs.com", is_production=True),
        ), patch.object(
            email_service,
            "_email_settings",
            return_value={
                "from": "PepPro <support@peppro.net>",
                "timeout": 15,
                "smtp": {
                    "host": "smtp.example.com",
                    "user": "support@peppro.net",
                    "pass": "secret",
                    "port": 587,
                    "ssl": False,
                    "starttls": True,
                    "auth": True,
                },
            },
        ):
            with self.assertRaisesRegex(RuntimeError, "legacy PepPro SMTP user"):
                email_service.send_email_verification_email("doctor@example.com", "123456")

    def test_email_verification_requires_google_smtp_for_domain_alignment(self):
        from python_backend.services import email_service

        with patch.object(
            email_service,
            "get_config",
            return_value=SimpleNamespace(frontend_base_url="https://trufusionlabs.com", is_production=True),
        ), patch.object(
            email_service,
            "_email_settings",
            return_value={
                "from": "TrufusionLabs <support@trufusionlabs.com>",
                "timeout": 15,
                "smtp": {
                    "host": "mail.trufusionlabs.com",
                    "user": "support@trufusionlabs.com",
                    "pass": "secret",
                    "port": 587,
                    "ssl": False,
                    "starttls": True,
                    "auth": True,
                },
            },
        ):
            with self.assertRaisesRegex(RuntimeError, "Google SMTP"):
                email_service.send_email_verification_email("doctor@example.com", "123456")

    def test_shipping_status_email_raises_when_production_dispatch_has_no_provider(self):
        from python_backend.services import email_service

        with patch.object(
            email_service,
            "get_config",
            return_value=SimpleNamespace(frontend_base_url="https://trufusionlabs.com", is_production=True),
        ), patch.object(
            email_service,
            "_email_settings",
            return_value={
                "from": "TrufusionLabs <support@trufusionlabs.com>",
                "timeout": 15,
                "smtp": {"host": None, "pass": None},
            },
        ):
            with self.assertRaises(RuntimeError):
                email_service.send_order_shipping_status_email(
                    "holly@example.com",
                    status="shipped",
                    customer_name="Holly O'Quin",
                    order_number="1505",
                    tracking_number="1ZSHIP1505",
                    carrier_code="ups",
                )


if __name__ == "__main__":
    unittest.main()
