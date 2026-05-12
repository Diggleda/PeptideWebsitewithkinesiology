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
        self.assertIn('width="360"', html)
        self.assertIn("width:360px", html)
        self.assertIn("max-width:70%", html)
        self.assertNotIn("width:100%", html)
        self.assertIn("background-color:rgb(55,126,186);", html)
        self.assertIn("background:rgb(55,126,186);", html)
        self.assertIn("background-image:none;", html)
        self.assertNotIn('background="cid:trufusion-leaf"', html)
        self.assertNotIn("url('cid:trufusion-leaf')", html)
        self.assertIn("min-height:100vh", html)
        self.assertIn("height:100vh", html)
        self.assertIn("background:rgba(255,255,255,0.64)", html)
        self.assertIn("backdrop-filter:blur(52px) saturate(1.9)", html)
        self.assertIn('td align="center" style="padding:0 14px;"', html)
        self.assertIn("<strong>Order: 1505</strong>", html)
        self.assertIn("<strong>Tracking: 1ZSHIP1505</strong>", html)
        self.assertNotIn("UPS tracking", html)
        self.assertIn('class="trufusion-track-button"', html)
        self.assertIn(".trufusion-track-button:hover", html)
        self.assertIn("background-color:rgb(11,6,121) !important", html)
        self.assertIn("color:#ffffff !important", html)
        self.assertIn('href="https://trufusionlabs.com"', html)
        self.assertIn(">trufusionlabs.com</a>", html)
        self.assertIn("Sign in to your account", dispatch_email.call_args.args[3])
        self.assertIn("background-color:rgba(255,255,255,0.95)", html)
        self.assertIn("color:rgb(11,6,121)", html)
        self.assertIn("border:2px solid rgb(11,6,121)", html)
        self.assertIn("border-radius:12px", html)
        self.assertNotIn("border-radius:999px", html)
        self.assertNotIn("background-color:#0B0679", html)
        self.assertNotIn("https://trufusionlabs.com/turfusionlabsphysiciansportal.png", html)
        self.assertNotIn("https://trufusionlabs.com/leafTexture.jpg", html)
        self.assertNotIn("/turfusionlabsphysiciansportal.png", html)
        self.assertEqual(dispatch_email.call_args.kwargs["bcc"], ("pgibbons@trufusionlabs.com",))
        self.assertTrue(dispatch_email.call_args.kwargs["raise_on_failure"])
        self.assertNotIn("cc", dispatch_email.call_args.kwargs)

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
            self.assertIn("background-color:rgb(55,126,186);", html)
            self.assertIn("background:rgb(55,126,186);", html)
            self.assertIn("background-image:none;", html)
            self.assertNotIn("cid:trufusion-leaf", html)
            self.assertNotIn("leafTexture", html)

        logo_spec = next(
            spec for spec in email_service._EMAIL_INLINE_IMAGE_SPECS if spec["content_id"] == "trufusion-logo"
        )

        self.assertEqual(logo_spec["filename"], "TrufusionLabs_PhysiciansPortal.png")

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
        self.assertIn("We received your contact form submission", dispatch_email.call_args.args[3])
        self.assertEqual(
            dispatch_email.call_args.kwargs["from_address"],
            "TrufusionLabs <support@trufusionlabs.com>",
        )
        self.assertEqual(dispatch_email.call_args.kwargs["cc"], ("support@trufusionlabs.com",))
        self.assertEqual(dispatch_email.call_args.kwargs["reply_to"], "support@trufusionlabs.com")
        self.assertNotIn("raise_on_failure", dispatch_email.call_args.kwargs)

    def test_delegate_links_beta_info_email_includes_badge_image(self):
        from python_backend.services import email_service

        html, plain = email_service._build_delegate_links_beta_info_email(base_url="https://trufusionlabs.com")

        self.assertIn('src="cid:delegate-white-label-sessions"', html)
        self.assertIn('alt="White label your delegate sessions"', html)
        self.assertIn('width="560" cellpadding="0" cellspacing="0" align="center"', html)
        self.assertIn("Welcome to the Delegate Links Beta", html)
        self.assertIn("Set up your brand", html)
        self.assertIn("font-family:'Lexend'", html)
        self.assertIn("font-size:21px", html)
        self.assertIn("font-size:30px", html)
        self.assertIn("font-weight:700", html)
        self.assertIn("font-weight:300", html)
        self.assertIn('<td style="padding:0 16px 14px 0;', html)
        self.assertIn(">1.</td>", html)
        self.assertIn(">2.</td>", html)
        self.assertIn(">3.</td>", html)
        self.assertNotIn("Set up your brand: add your logo and primary color in Account > Delegate Links Beta.", html)
        self.assertNotIn("Managing Delegate Links", html)
        self.assertIn("Open Delegate Links Beta", html)
        self.assertIn("1. Set up your brand", plain)

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
                "filename": "TrufusionLabs_PhysiciansPortal.png",
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
