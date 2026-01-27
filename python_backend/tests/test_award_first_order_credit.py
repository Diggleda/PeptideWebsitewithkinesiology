import sys
import types
import unittest


class AwardFirstOrderCreditTests(unittest.TestCase):
    def test_marks_referral_and_prospect_as_nurture_when_credit_awarded(self):
        # Allow importing the backend in environments where optional deps
        # (like `cryptography`) aren't installed.
        if "cryptography" not in sys.modules:
            cryptography = types.ModuleType("cryptography")
            hazmat = types.ModuleType("cryptography.hazmat")
            primitives = types.ModuleType("cryptography.hazmat.primitives")
            ciphers = types.ModuleType("cryptography.hazmat.primitives.ciphers")
            aead = types.ModuleType("cryptography.hazmat.primitives.ciphers.aead")

            class AESGCM:  # minimal stub
                def __init__(self, *_args, **_kwargs):
                    pass

                def encrypt(self, *_args, **_kwargs):
                    return b""

                def decrypt(self, *_args, **_kwargs):
                    return b""

            aead.AESGCM = AESGCM

            sys.modules["cryptography"] = cryptography
            sys.modules["cryptography.hazmat"] = hazmat
            sys.modules["cryptography.hazmat.primitives"] = primitives
            sys.modules["cryptography.hazmat.primitives.ciphers"] = ciphers
            sys.modules["cryptography.hazmat.primitives.ciphers.aead"] = aead

        if "pymysql" not in sys.modules:
            pymysql = types.ModuleType("pymysql")
            pymysql_cursors = types.ModuleType("pymysql.cursors")

            class DictCursor:  # minimal stub
                pass

            pymysql_cursors.DictCursor = DictCursor

            class _Connections(types.SimpleNamespace):
                class Connection:  # minimal stub
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

            class HTTPBasicAuth:  # minimal stub
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

        from python_backend.services import referral_service

        fixed_now = "2026-01-27T00:00:00Z"

        calls = {"referral_updates": [], "prospect_upserts": [], "ledger_inserts": []}

        class FakeUserRepo:
            def __init__(self):
                self.users = {
                    "p1": {
                        "id": "p1",
                        "name": "Purchaser",
                        "referrerDoctorId": "r1",
                        "salesRepId": "s1",
                    },
                    "r1": {"id": "r1", "name": "Referrer", "salesRepId": "s1"},
                }

            def find_by_id(self, user_id):
                return self.users.get(str(user_id))

            def adjust_referral_credits(self, doctor_id, amount):
                user = dict(self.users[str(doctor_id)])
                user["referralCredits"] = float(user.get("referralCredits") or 0) + float(amount)
                self.users[str(doctor_id)] = user
                return user

            def update(self, record):
                user_id = str(record.get("id"))
                self.users[user_id] = dict(record)
                return self.users[user_id]

        class FakeReferralRepo:
            def __init__(self):
                self.records = [
                    {
                        "id": "ref1",
                        "status": "converted",
                        "convertedDoctorId": "p1",
                        "referredContactName": "Purchaser",
                        "referredContactEmail": "purchaser@example.com",
                        "referredContactPhone": "555-0000",
                    }
                ]

            def get_all(self):
                return list(self.records)

            def update(self, record):
                calls["referral_updates"].append(dict(record))
                for idx, existing in enumerate(self.records):
                    if existing.get("id") == record.get("id"):
                        self.records[idx] = dict(record)
                        return self.records[idx]
                self.records.append(dict(record))
                return record

        class FakeLedgerRepo:
            def find_by_doctor(self, _doctor_id):
                return []

            def insert(self, entry):
                calls["ledger_inserts"].append(dict(entry))
                return dict(entry)

        class FakeSalesProspectRepo:
            def find_all_by_referral_id(self, referral_id):
                self.last_referral_id = referral_id
                return [
                    {
                        "id": "sp1",
                        "salesRepId": "s1",
                        "doctorId": None,
                        "referralId": referral_id,
                        "isManual": False,
                    }
                ]

            def upsert(self, record):
                calls["prospect_upserts"].append(dict(record))
                return dict(record)

        # Patch dependencies in-module.
        original = {
            "user_repository": referral_service.user_repository,
            "referral_repository": referral_service.referral_repository,
            "credit_ledger_repository": referral_service.credit_ledger_repository,
            "sales_prospect_repository": referral_service.sales_prospect_repository,
            "get_config": referral_service.get_config,
            "_now": referral_service._now,
        }
        try:
            referral_service.user_repository = FakeUserRepo()
            referral_service.referral_repository = FakeReferralRepo()
            referral_service.credit_ledger_repository = FakeLedgerRepo()
            referral_service.sales_prospect_repository = FakeSalesProspectRepo()
            referral_service.get_config = lambda: types.SimpleNamespace(referral={"fixed_credit_amount": 25.0})
            referral_service._now = lambda: fixed_now

            result = referral_service.award_first_order_credit("p1", "o1", 100.0)
            self.assertIsNotNone(result)

            self.assertEqual(len(calls["referral_updates"]), 1)
            updated_referral = calls["referral_updates"][0]
            self.assertEqual(updated_referral.get("status"), "nuture")
            self.assertEqual(updated_referral.get("creditIssuedAt"), fixed_now)
            self.assertEqual(updated_referral.get("creditIssuedAmount"), 25.0)
            self.assertEqual(updated_referral.get("creditIssuedBy"), "system")

            self.assertEqual(len(calls["prospect_upserts"]), 1)
            upsert = calls["prospect_upserts"][0]
            self.assertEqual(upsert.get("status"), "nuture")
            self.assertEqual(upsert.get("doctorId"), "p1")
            self.assertEqual(upsert.get("referralId"), "ref1")
        finally:
            for key, value in original.items():
                setattr(referral_service, key, value)


if __name__ == "__main__":
    unittest.main()
