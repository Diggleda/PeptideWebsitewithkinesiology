import sys
import types
import unittest
from types import SimpleNamespace
from unittest.mock import patch

if "requests" not in sys.modules:
    requests = types.ModuleType("requests")
    requests_auth = types.ModuleType("requests.auth")

    class HTTPBasicAuth:
        def __init__(self, *_args, **_kwargs):
            pass

    requests.RequestException = Exception
    requests.HTTPError = Exception
    requests.Timeout = TimeoutError
    requests.auth = requests_auth
    requests_auth.HTTPBasicAuth = HTTPBasicAuth
    sys.modules["requests"] = requests
    sys.modules["requests.auth"] = requests_auth


class EmailServiceTests(unittest.TestCase):
    def test_shipping_status_email_bccs_petergibbons(self):
        from python_backend.services import email_service

        with patch.object(
            email_service,
            "get_config",
            return_value=SimpleNamespace(frontend_base_url="https://peppro.net"),
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
        self.assertIn('src="cid:peppro-logo"', html)
        self.assertIn('width="360"', html)
        self.assertIn("width:360px", html)
        self.assertIn("max-width:70%", html)
        self.assertNotIn("width:100%", html)
        self.assertIn('background="cid:peppro-leaf"', html)
        self.assertIn("url('cid:peppro-leaf')", html)
        self.assertIn("background:rgba(255,255,255,0.78)", html)
        self.assertIn("backdrop-filter:blur(34px) saturate(1.9)", html)
        self.assertIn('class="peppro-track-button"', html)
        self.assertIn(".peppro-track-button:hover", html)
        self.assertIn("background-color:rgb(95,179,249) !important", html)
        self.assertIn("color:#ffffff !important", html)
        self.assertIn('href="https://peppro.net"', html)
        self.assertIn(">peppro.net</a>", html)
        self.assertIn("Sign in to your account", dispatch_email.call_args.args[3])
        self.assertIn("background-color:rgba(255,255,255,0.95)", html)
        self.assertIn("color:rgb(95,179,249)", html)
        self.assertIn("border:2px solid rgb(95,179,249)", html)
        self.assertIn("border-radius:12px", html)
        self.assertNotIn("border-radius:999px", html)
        self.assertNotIn("background-color:#5FB3F9", html)
        self.assertNotIn("https://peppro.net/PepPro_fulllogo.png", html)
        self.assertNotIn("https://peppro.net/leafTexture.jpg", html)
        self.assertNotIn("/Peppro_fulllogo.png", html)
        self.assertEqual(dispatch_email.call_args.kwargs["bcc"], ("petergibbons7@icloud.com",))
        self.assertTrue(dispatch_email.call_args.kwargs["raise_on_failure"])
        self.assertNotIn("cc", dispatch_email.call_args.kwargs)

    def test_sendgrid_payload_includes_cc_recipients(self):
        from python_backend.services import email_service

        response = SimpleNamespace(status_code=202, text="", raise_for_status=lambda: None)

        with patch.object(email_service.http_client, "post", return_value=response) as post:
            email_service._send_via_sendgrid(
                "holly@example.com",
                "PepPro order 1505 has shipped",
                "<p>Shipped</p>",
                {
                    "sendgrid_api_key": "sendgrid-key",
                    "sendgrid_endpoint": "https://sendgrid.example.test/send",
                    "from": "PepPro <support@peppro.net>",
                    "timeout": 15,
                },
                plain_text="Shipped",
                cc=("petergibbons7@icloud.com",),
            )

        payload = post.call_args.kwargs["json"]
        personalization = payload["personalizations"][0]
        self.assertEqual(personalization["to"], [{"email": "holly@example.com"}])
        self.assertEqual(personalization["cc"], [{"email": "petergibbons7@icloud.com"}])
        self.assertNotIn("bcc", personalization)

    def test_sendgrid_payload_includes_bcc_recipients(self):
        from python_backend.services import email_service

        response = SimpleNamespace(status_code=202, text="", raise_for_status=lambda: None)

        with patch.object(email_service.http_client, "post", return_value=response) as post:
            email_service._send_via_sendgrid(
                "holly@example.com",
                "PepPro order 1505 has shipped",
                "<p>Shipped</p>",
                {
                    "sendgrid_api_key": "sendgrid-key",
                    "sendgrid_endpoint": "https://sendgrid.example.test/send",
                    "from": "PepPro <support@peppro.net>",
                    "timeout": 15,
                },
                plain_text="Shipped",
                bcc=("petergibbons7@icloud.com",),
            )

        payload = post.call_args.kwargs["json"]
        personalization = payload["personalizations"][0]
        self.assertEqual(personalization["to"], [{"email": "holly@example.com"}])
        self.assertEqual(personalization["bcc"], [{"email": "petergibbons7@icloud.com"}])
        self.assertNotIn("cc", personalization)

    def test_sendgrid_payload_includes_inline_images_when_referenced(self):
        from python_backend.services import email_service

        response = SimpleNamespace(status_code=202, text="", raise_for_status=lambda: None)
        inline_images = (
            {
                "content_id": "peppro-logo",
                "filename": "PepPro_fulllogo.png",
                "mime_type": "image/png",
                "maintype": "image",
                "subtype": "png",
                "data": b"logo",
            },
            {
                "content_id": "peppro-leaf",
                "filename": "leafTexture-email.jpg",
                "mime_type": "image/jpeg",
                "maintype": "image",
                "subtype": "jpeg",
                "data": b"leaf",
            },
        )

        with patch.object(email_service, "_load_inline_email_images", return_value=inline_images), patch.object(
            email_service.http_client,
            "post",
            return_value=response,
        ) as post:
            email_service._send_via_sendgrid(
                "holly@example.com",
                "PepPro order 1505 has shipped",
                '<img src="cid:peppro-logo" /><table background="cid:peppro-leaf"></table>',
                {
                    "sendgrid_api_key": "sendgrid-key",
                    "sendgrid_endpoint": "https://sendgrid.example.test/send",
                    "from": "PepPro <support@peppro.net>",
                    "timeout": 15,
                },
                plain_text="Shipped",
            )

        attachments = post.call_args.kwargs["json"]["attachments"]
        self.assertEqual([attachment["content_id"] for attachment in attachments], ["peppro-logo", "peppro-leaf"])
        self.assertEqual([attachment["disposition"] for attachment in attachments], ["inline", "inline"])
        self.assertEqual([attachment["filename"] for attachment in attachments], ["PepPro_fulllogo.png", "leafTexture-email.jpg"])

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

            def send_message(self, msg, to_addrs=None):
                messages.append(msg)
                events.append(("send_message", msg["To"], msg["Cc"], tuple(to_addrs or ())))

            def quit(self):
                events.append(("quit",))

        inline_images = (
            {
                "content_id": "peppro-logo",
                "filename": "PepPro_fulllogo.png",
                "mime_type": "image/png",
                "maintype": "image",
                "subtype": "png",
                "data": b"logo",
            },
            {
                "content_id": "peppro-leaf",
                "filename": "leafTexture-email.jpg",
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
                "PepPro order 1505 has shipped",
                '<img src="cid:peppro-logo" /><table background="cid:peppro-leaf"></table>',
                {
                    "from": "PepPro <support@peppro.net>",
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
            )

        self.assertIn(("connect", "smtp-relay.gmail.com", 587, 15), events)
        self.assertIn(("starttls",), events)
        self.assertNotIn(("login", "support@peppro.net", ""), events)
        self.assertIn(
            ("send_message", "holly@example.com", "petergibbons7@icloud.com", ("holly@example.com", "petergibbons7@icloud.com")),
            events,
        )
        content_ids = [part["Content-ID"] for part in messages[0].walk() if part["Content-ID"]]
        self.assertEqual(content_ids, ["<peppro-logo>", "<peppro-leaf>"])

    def test_shipping_status_email_raises_when_production_dispatch_has_no_provider(self):
        from python_backend.services import email_service

        with patch.object(
            email_service,
            "get_config",
            return_value=SimpleNamespace(frontend_base_url="https://peppro.net", is_production=True),
        ), patch.object(
            email_service,
            "_email_settings",
            return_value={
                "from": "PepPro <support@peppro.net>",
                "timeout": 15,
                "sendgrid_api_key": None,
                "sendgrid_endpoint": "https://sendgrid.example.test/send",
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
