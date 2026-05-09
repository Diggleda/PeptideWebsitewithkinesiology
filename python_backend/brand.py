BRAND = {
    "name": "TrufusionLabs",
    "app_url": "https://www.trufusionlabs.com",
    "apex_url": "https://trufusionlabs.com",
    "api_url": "https://api.trufusionlabs.com",
    "shop_url": "https://shop.trufusionlabs.com",
    "port_url": "https://port.trufusionlabs.com",
    "support_email": "support@trufusionlabs.com",
    "legacy_support_email": "support@trufusionlabs.com",
    "logo_path": "public/turfusionlabsphysiciansportal.png",
}

LEGACY_BRAND = {
    "name": "PepPro",
    "order_table": "peppro_orders",
    "order_meta_prefix": "peppro",
    "support_email": "support@trufusionlabs.com",
    "media_auth_cookie_name": "peppro_media_token",
}


def legacy_meta_key(key: str) -> str | None:
    if not key.startswith("trufusion"):
        return None
    return f"peppro{key[len('trufusion'):]}"


def with_legacy_meta_keys(*keys: str) -> list[str]:
    expanded: list[str] = []
    for key in keys:
        if key and key not in expanded:
            expanded.append(key)
        legacy = legacy_meta_key(key or "")
        if legacy and legacy not in expanded:
            expanded.append(legacy)
    return expanded
