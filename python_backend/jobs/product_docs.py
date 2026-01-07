from __future__ import annotations

from typing import Any, Dict

from ..services.product_document_sync_service import sync_woo_products_to_product_documents
from ..worker_bootstrap import bootstrap


def sync_product_documents() -> Dict[str, Any]:
    """
    RQ job: ensure Woo products exist in product_documents table for COA storage.
    """
    bootstrap()
    return sync_woo_products_to_product_documents()

