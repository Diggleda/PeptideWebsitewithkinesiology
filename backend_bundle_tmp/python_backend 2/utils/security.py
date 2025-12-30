import base64
import hashlib
import hmac
from typing import Optional


def verify_woocommerce_webhook_signature(
    body: bytes, signature: Optional[str], secret: str
) -> bool:
    """
    Verify the signature of a WooCommerce webhook.

    Args:
        body: The raw request body.
        signature: The value of the X-WC-Webhook-Signature header.
        secret: The webhook secret.

    Returns:
        True if the signature is valid, False otherwise.
    """
    if not signature:
        return False

    try:
        secret_bytes = secret.encode("utf-8")
        mac = hmac.new(secret_bytes, body, hashlib.sha256)
        digest = base64.b64encode(mac.digest()).decode("utf-8")

        return hmac.compare_digest(signature, digest)
    except Exception:
        return False
