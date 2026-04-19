from __future__ import annotations

import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import python_backend
from python_backend import config as config_module
from python_backend import database as database_module
from python_backend import logging_config as logging_config_module
from python_backend import routes as routes_module
from python_backend import services as services_module
from python_backend import storage as storage_module
from python_backend.middleware import rate_limit as rate_limit_module
from python_backend.middleware import request_logging as request_logging_module
from python_backend.middleware import shadow_mode as shadow_mode_module
from python_backend.repositories import sales_prospect_repository
from python_backend.repositories import user_repository
from python_backend.services import patient_links_sweep_service
from python_backend.services import presence_sweep_service
from python_backend.services import product_document_sync_service
from python_backend.services import shipstation_status_sync_service
from python_backend.services import ups_status_sync_service


class AppBootstrapModeTests(unittest.TestCase):
    def test_web_background_jobs_mode_defaults_to_thread(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(python_backend._resolve_web_background_jobs_mode(), "thread")

    def test_web_background_jobs_mode_accepts_external(self) -> None:
        with patch.dict(os.environ, {"PEPPRO_WEB_BACKGROUND_JOBS_MODE": "external"}, clear=True):
            self.assertEqual(python_backend._resolve_web_background_jobs_mode(), "external")

    def test_create_app_initializes_storage_before_starting_background_jobs(self) -> None:
        order: list[str] = []
        config = SimpleNamespace(
            flask_settings={},
            port=3001,
            is_production=False,
            mysql={"enabled": False},
        )

        with patch.object(config_module, "load_config", return_value=config), \
            patch.object(logging_config_module, "configure_logging"), \
            patch.object(services_module, "configure_services"), \
            patch.object(database_module, "init_database", side_effect=lambda cfg: order.append("database")), \
            patch.object(storage_module, "init_storage", side_effect=lambda cfg: order.append("storage")), \
            patch.object(sales_prospect_repository, "ensure_house_sales_rep_for_contact_forms"), \
            patch.object(user_repository, "backfill_contact_form_lead_types"), \
            patch.object(product_document_sync_service, "start_product_document_sync", side_effect=lambda: order.append("product")), \
            patch.object(shipstation_status_sync_service, "start_shipstation_status_sync", side_effect=lambda: order.append("shipstation")), \
            patch.object(ups_status_sync_service, "start_ups_status_sync", side_effect=lambda: order.append("ups")), \
            patch.object(presence_sweep_service, "start_presence_sweep", side_effect=lambda: order.append("presence")), \
            patch.object(patient_links_sweep_service, "start_patient_links_sweep", side_effect=lambda: order.append("patient")), \
            patch.object(request_logging_module, "init_request_logging"), \
            patch.object(rate_limit_module, "init_rate_limit"), \
            patch.object(shadow_mode_module, "init_shadow_mode"), \
            patch.object(routes_module, "register_blueprints"):
            python_backend.create_app()

        self.assertIn("storage", order)
        self.assertLess(order.index("storage"), order.index("product"))
        self.assertLess(order.index("storage"), order.index("presence"))


if __name__ == "__main__":
    unittest.main()
