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
    def test_shipping_status_email_ccs_petergibbons(self):
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
        self.assertEqual(dispatch_email.call_args.kwargs["cc"], ("petergibbons7@icloud.com",))
        self.assertTrue(dispatch_email.call_args.kwargs["raise_on_failure"])
        self.assertNotIn("bcc", dispatch_email.call_args.kwargs)

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

    def test_smtp_relay_can_skip_login_when_auth_disabled(self):
        from python_backend.services import email_service

        events = []

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
                events.append(("send_message", msg["To"], msg["Cc"], tuple(to_addrs or ())))

            def quit(self):
                events.append(("quit",))

        with patch.object(email_service.smtplib, "SMTP", FakeSMTP):
            email_service._send_via_smtp(
                "holly@example.com",
                "PepPro order 1505 has shipped",
                "<p>Shipped</p>",
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
