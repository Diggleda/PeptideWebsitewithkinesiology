from __future__ import annotations

from typing import Callable, List, Optional

from .json_store import JsonStore


user_store: Optional[JsonStore[List[dict]]] = None
order_store: Optional[JsonStore[List[dict]]] = None
sales_rep_store: Optional[JsonStore[List[dict]]] = None
referral_code_store: Optional[JsonStore[List[dict]]] = None
referral_store: Optional[JsonStore[List[dict]]] = None
sales_prospect_store: Optional[JsonStore[List[dict]]] = None
sales_prospect_quote_store: Optional[JsonStore[List[dict]]] = None
credit_ledger_store: Optional[JsonStore[List[dict]]] = None
contact_form_store: Optional[JsonStore[List[dict]]] = None
bug_report_store: Optional[JsonStore[List[dict]]] = None
contact_form_status_store: Optional[JsonStore[dict]] = None
settings_store: Optional[JsonStore[dict]] = None
peptide_forum_store: Optional[JsonStore[dict]] = None
seamless_store: Optional[JsonStore[List[dict]]] = None


def _make_store(config, file_name: str, default) -> JsonStore:
    secret = (config.encryption.get("key") or "").strip() if config.encryption else ""
    algorithm = config.encryption.get("algorithm", "aes-256-gcm") if config.encryption else "aes-256-gcm"
    if isinstance(default, list):
        default_factory = lambda: list(default)
    else:
        default_factory = lambda: default
    return JsonStore(
        base_dir=config.data_dir,
        file_name=file_name,
        default_factory=default_factory,
        encryption_secret=secret or None,
        encryption_algorithm=algorithm,
    )


def init_storage(config) -> None:
    global user_store, order_store, sales_rep_store, referral_code_store, referral_store, sales_prospect_store, sales_prospect_quote_store, credit_ledger_store, contact_form_store, bug_report_store, contact_form_status_store, settings_store, peptide_forum_store, seamless_store

    user_store = _make_store(config, "users.json", [])
    order_store = _make_store(config, "orders.json", [])
    sales_rep_store = _make_store(config, "sales-reps.json", [])
    referral_code_store = _make_store(config, "referral-codes.json", [])
    referral_store = _make_store(config, "referrals.json", [])
    sales_prospect_store = _make_store(config, "sales-prospects.json", [])
    sales_prospect_quote_store = _make_store(config, "sales-prospect-quotes.json", [])
    credit_ledger_store = _make_store(config, "credit-ledger.json", [])
    contact_form_store = _make_store(config, "contact-forms.json", [])
    bug_report_store = _make_store(config, "bug-reports.json", [])
    contact_form_status_store = _make_store(config, "contact-form-statuses.json", {})
    settings_store = _make_store(
        config,
        "settings.json",
        {
            "shopEnabled": True,
            "betaServices": [],
            "peptideForumEnabled": True,
            "stripeMode": None,
            "salesBySalesRepCsvDownloadedAt": None,
            "salesLeadSalesBySalesRepCsvDownloadedAt": None,
        },
    )
    peptide_forum_store = _make_store(
        config,
        "the-peptide-forum.json",
        {"updatedAt": None, "items": []},
    )
    seamless_store = _make_store(config, "seamless.json", [])

    for store in (
        user_store,
        order_store,
        sales_rep_store,
        referral_code_store,
        referral_store,
        sales_prospect_store,
        sales_prospect_quote_store,
        credit_ledger_store,
        contact_form_store,
        bug_report_store,
        contact_form_status_store,
        settings_store,
        peptide_forum_store,
        seamless_store,
    ):
        if store:
            store.init()


__all__ = [
    "init_storage",
    "user_store",
    "order_store",
    "sales_rep_store",
    "referral_code_store",
    "referral_store",
    "sales_prospect_store",
    "sales_prospect_quote_store",
    "credit_ledger_store",
    "contact_form_store",
    "bug_report_store",
    "contact_form_status_store",
    "settings_store",
    "peptide_forum_store",
    "seamless_store",
]
