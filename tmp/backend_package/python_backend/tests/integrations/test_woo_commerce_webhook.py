
import unittest
from unittest.mock import MagicMock, patch

from python_backend.integrations.woo_commerce_webhook import handle_order_updated
from python_backend.integrations.service_error import ServiceError


class TestWooCommerceWebhook(unittest.TestCase):
    @patch("python_backend.integrations.woo_commerce_webhook.user_repository")
    @patch("python_backend.integrations.woo_commerce_webhook.credit_ledger_repository")
    def test_handle_order_updated_refund(
        self, mock_credit_ledger_repository, mock_user_repository
    ):
        # Arrange
        mock_user = {
            "id": "user-123",
            "referralCredits": 100.0,
        }
        mock_user_repository.find_by_email.return_value = mock_user
        mock_credit_ledger_repository.insert.return_value = {"id": "ledger-entry-456"}

        order_data = {
            "id": "order-abc",
            "status": "refunded",
            "total": "-50.00",
            "billing": {"email": "test@example.com"},
        }

        # Act
        result = handle_order_updated(order_data)

        # Assert
        self.assertEqual(result["status"], "processed")
        self.assertEqual(result["ledger_entry_id"], "ledger-entry-456")

        mock_user_repository.find_by_email.assert_called_once_with("test@example.com")
        mock_credit_ledger_repository.insert.assert_called_once_with(
            {
                "doctor_id": "user-123",
                "amount": 50.0,
                "direction": "credit",
                "reason": "order_refund",
                "description": "Credit from refunded order #order-abc",
                "related_entity_type": "order",
                "related_entity_id": "order-abc",
            }
        )
        mock_user_repository.adjust_referral_credits.assert_called_once_with("user-123", 50.0)


if __name__ == "__main__":
    unittest.main()
