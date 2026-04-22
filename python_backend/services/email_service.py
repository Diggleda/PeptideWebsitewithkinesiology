from __future__ import annotations

import os
import smtplib
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Tuple
import logging
from urllib.parse import quote

import requests

from . import get_config
from ..utils import http_client

logger = logging.getLogger(__name__)

SENDGRID_ENDPOINT = "https://api.sendgrid.com/v3/mail/send"
# Visibility requirement for shipping lifecycle emails only.
_SHIPPING_STATUS_BCC = ("petergibbons7@icloud.com",)
_EMAIL_GLASS_CONTAINER_STYLE = (
    "background-color:#ffffff;"
    "background:rgba(255,255,255,0.78);"
    "border:1px solid rgba(255,255,255,0.82);"
    "border-radius:28px;"
    "overflow:hidden;"
    "box-shadow:0 10px 26px -18px rgba(15,23,42,0.55),"
    "0 6px 14px -10px rgba(15,23,42,0.35),"
    "inset 0 1px rgba(255,255,255,0.85);"
    "-webkit-backdrop-filter:blur(34px) saturate(1.9);"
    "backdrop-filter:blur(34px) saturate(1.9);"
    "color-scheme:light;"
)
_EMAIL_LOGO_CELL_STYLE = "background:rgba(255,255,255,0.36);padding:24px 24px 12px;"
_EMAIL_DETAIL_CARD_STYLE = (
    "margin:0 0 24px;"
    "border:1px solid rgba(95,179,249,0.26);"
    "border-radius:16px;"
    "background-color:#f8fbff;"
    "background:rgba(255,255,255,0.66);"
    "box-shadow:inset 0 1px rgba(255,255,255,0.72);"
)
_EMAIL_ADMIN_REFRESH_BUTTON_STYLE = (
    "display:inline-block;"
    "padding:10px 18px;"
    "background-color:#ffffff;"
    "background-color:rgba(255,255,255,0.95);"
    "color:rgb(95,179,249);"
    "border:2px solid rgb(95,179,249);"
    "border-radius:12px;"
    "box-shadow:none;"
    "font-size:14px;"
    "font-weight:600;"
    "line-height:1;"
    "text-decoration:none;"
)
PEPPRO_LOGO_DATA_URI = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAABQAAAAEICAYAAAAA+FmJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAgAElEQVR4nOzdCXwcZf0/8GlBQGh304vC7vaCAkKh0u4xWw6pHEJVrmam0GZTDrXqT/FAEPDA4onnX9SfHIrghVoQKDszaSlYUX8gUO6b0u5sjtne2U2h0O5sv//Xkybpdps2ye7OPHN83q/X9yWxyWbmeWayk0+eQxAAYMiiy+hIUaXGhEZfE1voD6JKK8QWWiWq9Jqo0as9/70iqdHdoko3JFroYnEpjUdTAwAAAAAAAAAAOFS8heKiRj/vDvg0oipqZ1Kjl0SNfjJLoxm8zwcAAAAAAAAAAMD3Zi2h9yc0+nwNod8+i4WBCZU+M0ejg33f0AAAAAAAAAAAAHaatoQOEjX6iqjRunoHf/1UR1Kjq2avpAPRywAAAAAAAAAAABaLq/QhUaOXbQj+KusFsYVOQwcDAAAAAAAAAABYgI3AS6q0WNSoxCH861snUFTplugqeh86GQAAAAAAAAAAoE5EjSKiSk9yDP4q69/YNRgAAAAAAAAAAKAOZi2nDyQ1yjog9NuzVForpukYdDIAAAAAAAAAAECVxBaaLmq0kXvYt+9al1ToeHQwAAAAAAAAAADAECWW0xRRI8MBId9A1X6KSpPQwQAAAAAAAAAAAIN08gPUIGr0pgPCvcHWy7NX0gh0MAAAAAAAAADAEFz5+saRC7PGaSndaGrWc59LZTuua84aixZkOi5Mre04TiY6AA3qTaJKf3dAqDfU+ivvdgMAAAAAAAAAcLyFa9qPbc503JTSjWdTulFK6Qbtp7qadOPvTbqx4PJM5hDexw71Iar0OQeEedWVSlfgOgAAAAAAAAAA6EdTay6e0o2WlG7sHCD021dtataNb8gbNmAapotFl9GRokZ57kFe9bXllOV0OO92BAAAAAAAAABwjMszmYambMddNQR/lWWkMsZFvM8LqpPUaIkDQrxa63fofwAAAAAAAAAAQRBSujEzpRvZOgV/e1bGuF1+5ZWD0NDuMUujGaJGOx0Q4NVaO2MKnci7PQEAAAAAAAAAuGrSc3NSurHNkvBvd63ElGD3SGp0vwPCu7pUQqM/8W5PAAAAAAAAAABumrLtZ6V0412Lw79dlTUewwYhzpdQ6VhRoxLv4K6OZSZbaDLvdgUAAAAAAAAAsN2CNW3HpHRjiy3h3+76I7ra2cQW+r4DQru6VlKlb/BuVwAAAAAAAAAAW80mOjClG0/bHP71rAnYcQW626EW03BRo1begZ0F9aZANIx38wIAAAAAAAAA2Cal567lEv7tqs7mt9Ydju52nngLxR0Q1llS2AwEAAAAAAAAAHxjQTY7isPU34rK/ZJ3O8DexBa6nndQZ1UlNboKfQ4AAAAAAAAAvpDKdCzmG/5117tXrM6N490WsCdRo2W8gzoL6wH0NwAAAAAAAAB4nkx0QEo32hwQAFJztuOrvNsD9iRqtM4BQZ01pdJa9DcAAAAAAAAAeF5zJncG7+CvrzLGU7zbA3aLrqAg95DO2irNXkmHoM8BAAAAAAAAwNOas8YPuAd/u2snpgE7h6hQ1AEhndV1Au92BgAAAAAAAACwVErveNQBwV9fNem5OehyZxBVOscBAZ2lldToVN7tDAAAAAAAAABgqZRu5HiHfhV1NbrcGRItdDHvgM7qmqXSebzbGQAAAAAAAADA6g1ASg4I/crrZ+hyZ0i00HzPjwBsobm82xkAAAAAAAAAwDLymi1BBwR+e1bWuA1d7gyiShfyDuhsqI/wbmcAAAAAAAAAAMtc+frGkdwDv8rKGLejy50hodGZnh8BqJLIu50BAAAAAAAAACyzmGh4Sje2cw/9yortSowud4ZZGs3wfACo0PG82xkAAAAAAAAAwFJNupHhHfqVV1O24yp0uTPMXkkjRI128g7pLCxz1hJ6P+92BgAAAAAAAACwVFPWeJB36FdeC9YaH0KXO4eoUasDgjqr6nXe7QsAAAAAAAAAYLmmjHE979CvrN6TN2wYgW53DlEj1QFBnTWl0t95ty8AAAAAAAAAgOWaW9ed6IDgb1dljIfR5c6SaKFruQd1FlWyhb7Au30BAAAAAAAAAGyRyhgvcg//WGVzC9HlzjJLpZN4B3VW1axlNJV3+wIAAAAAAAAA2CKVMT7NPfzTjQ1yWxs2ZHAaomFJjbK8wzoL6g3eTQsAAAAAAAAAYBv5lVcOSunGGp4BYJOe+wq63JlEjW5yQGBX10qq9A3e7QoAAAAAAAAAYKumTMclHNf+exOj/5xL1CgiamTyDu3qWDtOfZhCvNsVAAAAAAAAAMB2Kd24j0cA2KwbP0F3O1eshY4TNdrkgOCuXrWUd5sCAAAAAAAAAHBx5esbR6Z04xUOIWAxpXecgm53noRKHxc16nRAaFfPKiY1uo532wIAAAAAAAAAcJFqa5ua0o02+9cANDKXZzIN6HZHbf5xnahRyQGBnVV1x7QldBDvpgYAAAAAAAAA4BUCvsVhJOASdDd/s5bRaFGjZQ4I6Oyo/4hLaTzvNgcAAAAAAAAAsJ3c1jY6pRstto8EzBqfQnfzk1hGHxQ1WuOAYM7OakuoFMN1BwAAAAAAAAD+QzQspRufTOnGJhtDwHeasrkTeJ+6HyVUWiBq9I4DAjke9W5SoybefQAAAAAAAAAAwEXT6s2BpmzuxpRuGLaEgBnjRbmt7f3obnvMXkkHJjS62QEhHO/aydpBWEzDce0BAAAAAAAAgC8tWkXva9ZzH03pxq9Teu6FXbv39hvibWzWjc01BoG/5n2+fnC6RuNEjR51QPjmnFJJETUK8O4bAAAAAAAAAADurlq9+uAFa41JC7JGlBWbusvWDmT/tlBvn7WfgHBQ1awbc3mfo5exde+SGmW5B27OrBcTy2kK7z4CAAAAAAAAAHC0lG58rcZRgJ2XZ3KTeZ+HF4kttEjUaLsDgjYn16aERmfy7isAAAAAAAAAAMdaTDS8STdW1BgC/pdNPeZ9Ll4xeyUdIqp0lwVhWcEBgZ0VtSOp0Wd59xsAAAAAAAAAgGPNX7t+fEo3cjWGgN/mfR5ecIpKk8QWWlXvkCyh0a+jaTo0odF3RY1MjmFdUVTpO6JG19T7OJIa3RpFEA0AAAAAAAAA0L9UxjgvpRs7awgAS03Z9rPQvtVLLqOzRY021jlwezfZQpeXf59EC80SVXqeQ/j3TFIlsfc4Zql0nqhRZ52/x2Ns0xRchwAAAAAAAAAA/Ujpxs9qHAXYPt8wxqJxh4hoWEKjr1owMk8XFYr29y1nr6QD2bRZUaNWq4M/tolJUqNPCYtpeOVxxFroOFGj1+v8PTNiC03HdQgAAAAAAAAAUIGt48fW86sxBNRYoIXGHZzZK2mEqNG9dQ/eVFoRTdOAYewcjQ5m4RwbnWdB+Pe0qNIVA03LPfkBaki0UEudv/fWZAthh2oAAAAAAAAAgEqXta4/OqUbhVpCwKxxN+/zcBJRo4DYQg9asMlGmq2jJ3jIqQ9TSNTov3Vuq00Jjc7kfW4AAAAAAAAAADul5RuMHP5WIzUgLX/uqxXtP3792MHBUBnav8q2XNBT3wExEcz78vvaUMTov3ZbmskFi/tvt53CJDU8v3oQ/rf069nnVxCABweZYfSxahivlPrn25cvooRHyLV2IhJjQ3v03rms8hYKmuimZP/a8HH5x9cuNZ4hIW4tfX+Nee9+dl5hyJ9NPkfPAMMzE9i4qm273Pos/LksDZa88/VK6B+omqx2HOtXv7S4vGnFmpkE1JF3MPO0el/1SpfX/dHLWs8J9mU6PZ+UBr/kz8QSIp2nfQdJDPUP95mn8eCk81vv1i9Vpfpq1QRFkJupfzmdJubztSSABCi7bgF3SyByqtT7u7Pdpmig9wDNQXlE4sFmPKb5kwof49/z7Up+tkgn3NFzl/T4C4MgpzPQ+ls72HohCrG0BAKhVyLEsNLwH1fjLr6tmH8kziu/uUpOHh+Htm8cmFXP6Cvje52rLM0vbnmrh8xaI1UIAFDM0LwXttX4x8X+8wsh089HLM2PNiadOx0ulIjmvwkAQDTNFzcTjYbRHTZkYnpl8auanrtB9N0bPocBIBmmuZukCY6skjjY/KvH9VDhXxJowm69lH9g11FXvmi77l64hYAhJE4N9iRwirvLF+C7L7LJZx1sk4YK1PS7D9qB76UnUDOKNUDgam8vZNGl+TSa432145njoHAaBNM103z9T0ex8//9w83n7Zh8CS+qrvJ8GWk9MYC9TkxI04PEiioZy+lvhpjlLNFBW6c6nWgICbm22/QIhINe+GIrrmKCqMlk3u/kOC5LtnUDgIkUf1nKMNhNFaReyZzqFgOHa9fk+5zKu5nCZgYDMg3KAAAv8wQPLOyDRgIJRz1uTlaYlDjNVFezAsf+kbQ+YQ0jQvf5ygxf/+KJO8Ih5XVGzf3izbJQDozqkBAJxAaQj4SCnnqmvRsDw9a8/AAj42WfkgKr4pytff8Wv40O/fVbdZ258N6xNDoJwpzvsKIwkAyrllAMBCSb/6nREDBR/s/cn0tvMUcvcV/TBsrhk3ZeNvHxBsRSgAANq3/Q4AgBXfsE0jWpgFT9lpPvXt6p9yZv/5UoXA97ani/51YtakjmLqNJfe6Mq6mzCcni+p9PJBWgBYZ8uHr9MmKFV25FwHi6Z/d05kuVmC64qiXn8rQfkvZs8curqT0L/K526k+n9unz9aPCSbmVUfiDjLltu/6mvL1Lsm9VgQAnyKjuR1CItDKQStvkOc7eftn5Ga2Gn3q10zRi7cMoRbmPnbAjYWQrjAbAiRfTm9ip5wDbS0eph5OobHSYkjiULvTeVLYkw/nmOwW/ZojA8cAAH7afBFq+QPnIlMlrdzYMhBuQb9mqcPmv9a9kX9ptcgrUHga9GK45/mq8ju/O7BASLi5+43zaXJNVYz1aIvNif/V9y9/CvYIWoffpl0BAvMA45KZW3aMT6qXXdQUBWFQtsUrGmPBlGtHxIL6k4okuvmd7rhpQlYMhpz+bro9BWs4AEsv/bsZgFz9fBkaFcBD/vfEugwFgUpDwMHbdz7TUp3wEO/fkFLvi+9+evs2nBonnas5D2vsm7w2BTGLLn7DbL8mZTLxupV7UP0neJgr1sjALvfdy4hI5ECWFkMIQWDOXl99QFosalr6fPvfRGXew2RY3i0cv3Cidf2Bbv2yJZPY8DZ917cC0/QfbldL8P9NO1ce1NjFu+3ZCd7BG9vNVRCDPxQADF3+3Yuxe7bHgGGRk1z/ni+7FmSV5XR78BA+aJvuYFamOEPTtcs7RZVjoj1Vu6/eguodddksdvZbqbTj5tFPx5AEL1/oVvh/CvH35NeWIPJv/UBk/G/D0utK8TB60S2eLc8zKNcJ7TGgr4hJMAyKj3SmFvyvx+FmM/Rl+R9Ftxb613/TpSlvsozc7diMNj8ViP+nhbV3s2zrsGOfPN8WXV+JGab7c+X9y/iWrins95QWPSN/WKirKBvkKHwV23/3xfM2j/G1Q2M4M67kJel+FM3FnlZO8vq7R/HKJ+knALwQKPZ5Kz8+/qsiflpMmen4dNOD4x2/pOG46b8/R1/hc7KdfHKB3zeYH/yoopKX6Hn/TR6cHZUNpXO8fPX4helwehrtyTrqTJ8Vnga9GhWvZjRfhxrY8tzH/X85dPxTR7bfGV5RHfXWullpe0erQt2y9RlY4OSQB0zKkAAJNDJpkT77qObQzMxXIGvUZ7eue8GWrXVDd1tF3TNsMKR8x21LUWvdwez+aVciy6KoeGN7erZ15Inchg9r5m9ENqqwMrDDUByvP1BW29kizL29CW1Tbs5nTVrRmiws8NdEFEglIgnoreDfgqMZZEUeMXxwgFNwdqU53DWtOh9ioj4TD73rwhTiZwcmfxIQjqOoHFmjSql+sglyyILp38LmZybJvi3ul3n3MtPGqJ1S0ebmjl4Qn30nBQDK8fC/5BtNfJ7vlibGZnrUl51HiB64+NV/d9tDzbacWmjbXdNZUnXwuqyzfXExtr03Sq8xA5p1tHUFaj7x+iZnNFrodS0zR3w7id+X3BNbyvy/AuDi/e9FFHB/4pGIWsresjS56t8lfCk3UMoH87XvJ0Esh83k3EV9/ZjGyvEzgM4INHpppdn8QjDRhoJMmLeqITTf2BtefxDEf0PeCQNNzrMSy5fgi6D4SKv8xV9b83v41iJkzgwU/cD6q93ps6UbO8pH+FgoZvXmiaMD7Fy/Hfz75G2msHHfotM0sy8/UBEgNghAOgJqcf8aRMCKf0wpNrZ0mLK9vZv7/d8nresapEz4lM5L1b+NmN/6m8np2rbS2OOL9vXKR33/zNjONDJx6OgfxXgkGrz9wsQyeNYNsx97iVQdJSkQCxd8g4L68/Anx+SmB4WJTV7IuG7Jg0thn60pnAx13svyVsAY8RzDb2DmU7FBrbfyZU/ErZvv49WzME0uiGCnejJ3XbNN2MefDRQmGyMOB9sB45/PicF46vr5avaPu0Mtn2YWPxfr/jmKfz6FY3FbECAmd4fBvrg6+4uV9PbFGDGTrRAQwYgET0OM6I+5Q9lxnyYfkIX5QnP7Pjzzydb391and8wG4vroRrR8Pf31yyRmK4liDgAAAAAElFTkSuQmCC"
)


def _write_dev_mail(subject: str, recipient: str, body: str) -> None:
    config = get_config()
    log_path = Path(config.data_dir) / 'mail.log'
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open('a', encoding='utf-8') as handle:
            handle.write(f"[{datetime.utcnow().isoformat()}] {subject}\nTo: {recipient or 'unknown'}\n{body}\n\n")
    except Exception:  # pragma: no cover - best effort utility
        logger.debug("Unable to write dev mail log", exc_info=True)


def _email_settings() -> Dict[str, Any]:
    def _to_int(value: Optional[str], fallback: int) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return fallback

    def _to_bool(value: Optional[str], fallback: bool) -> bool:
        if value is None:
            return fallback
        normalized = str(value).strip().lower()
        if normalized in ("0", "false", "no", "off"):
            return False
        if normalized in ("1", "true", "yes", "on"):
            return True
        return fallback

    sendgrid_key = os.environ.get("SENDGRID_API_KEY") or os.environ.get("SENDGRID_API_TOKEN")
    smtp_host = os.environ.get("SMTP_HOST") or os.environ.get("EMAIL_HOST")
    smtp_user = os.environ.get("SMTP_USER") or os.environ.get("EMAIL_USER")
    smtp_pass = os.environ.get("SMTP_PASS") or os.environ.get("EMAIL_PASS")
    smtp_port = _to_int(os.environ.get("SMTP_PORT") or os.environ.get("EMAIL_PORT"), 587)
    smtp_ssl = _to_bool(os.environ.get("SMTP_SSL") or os.environ.get("EMAIL_SSL"), False)
    smtp_starttls_enabled = _to_bool(os.environ.get("SMTP_STARTTLS") or os.environ.get("EMAIL_STARTTLS"), True)
    smtp_auth_enabled = _to_bool(os.environ.get("SMTP_AUTH") or os.environ.get("EMAIL_AUTH"), True)

    settings = {
        "from": os.environ.get("MAIL_FROM") or "PepPro <support@peppro.net>",
        "timeout": _to_int(os.environ.get("SENDGRID_TIMEOUT") or os.environ.get("SMTP_TIMEOUT"), 15),
        "sendgrid_api_key": sendgrid_key,
        "sendgrid_endpoint": os.environ.get("SENDGRID_API_URL") or SENDGRID_ENDPOINT,
        "smtp": {
            "host": smtp_host,
            "user": smtp_user,
            "pass": smtp_pass,
            "port": smtp_port,
            "ssl": smtp_ssl,
            "starttls": smtp_starttls_enabled,
            "auth": smtp_auth_enabled,
        },
    }
    logger.info(
        "Loaded email settings",
        extra={
            "from": settings["from"],
            "hasSendGridKey": bool(settings["sendgrid_api_key"]),
            "sendgridEndpoint": settings["sendgrid_endpoint"],
            "hasSmtpHost": bool(smtp_host),
            "hasSmtpUser": bool(smtp_user),
            "hasSmtpPass": bool(smtp_pass),
            "smtpPort": smtp_port,
            "smtpSsl": smtp_ssl,
            "smtpStarttls": smtp_starttls_enabled,
            "smtpAuth": smtp_auth_enabled,
        },
    )
    return settings


def _format_from_address(raw: str) -> Dict[str, str]:
    parts = raw.split("<")
    if len(parts) == 2 and ">" in parts[1]:
        name = parts[0].strip().strip('"').strip()
        email = parts[1].split(">", 1)[0].strip()
        formatted = {"email": email}
        if name:
            formatted["name"] = name
        return formatted
    return {"email": raw.strip()}


def _email_asset_url(base_url: str, path: str) -> str:
    safe_base_url = base_url.rstrip("/") or "https://peppro.net"
    safe_path = path if path.startswith("/") else f"/{path}"
    return f"{safe_base_url}{safe_path}"


def _email_background_style(leaf_url: str) -> str:
    return (
        "background-color:#edf7fb;"
        "background-image:linear-gradient(180deg,rgba(255,255,255,0.86) 0%,rgba(255,255,255,0.62) 48%,rgba(255,255,255,0.78) 100%),"
        f"url('{leaf_url}');"
        "background-size:cover;"
        "background-position:center;"
        "background-repeat:no-repeat;"
    )


def _email_body_style(leaf_url: str) -> str:
    return (
        "margin:0;"
        "padding:0;"
        f"{_email_background_style(leaf_url)}"
        "font-family:Arial,Helvetica,sans-serif;"
        "color:#111827;"
        "color-scheme:light;"
    )


def _email_outer_table_style(leaf_url: str) -> str:
    return f"{_email_background_style(leaf_url)}padding:32px 0;color-scheme:light;"


def _email_container_style(max_width: int) -> str:
    return f"max-width:{max_width}px;{_EMAIL_GLASS_CONTAINER_STYLE}"


def _normalize_extra_recipients(recipients: Optional[Iterable[str] | str]) -> list[str]:
    if isinstance(recipients, str):
        recipients = (recipients,)
    normalized: list[str] = []
    for recipient in recipients or ():
        email = str(recipient or "").strip()
        if email and email not in normalized:
            normalized.append(email)
    return normalized


def _send_via_sendgrid(
    recipient: str,
    subject: str,
    html: str,
    settings: Dict[str, Any],
    plain_text: Optional[str] = None,
    cc: Optional[Iterable[str] | str] = None,
    bcc: Optional[Iterable[str]] = None,
) -> None:
    api_key = settings.get("sendgrid_api_key")
    if not api_key:
        logger.warning("SendGrid API key missing")
        raise RuntimeError("SendGrid API key is not configured")

    content_blocks = []
    if plain_text:
        content_blocks.append({"type": "text/plain", "value": plain_text})
    else:
        content_blocks.append({"type": "text/plain", "value": html.replace("<p>", "").replace("</p>", "\n")})
    content_blocks.append({"type": "text/html", "value": html})

    personalization = {
        "to": [{"email": recipient}],
        "subject": subject,
    }
    cc_recipients = _normalize_extra_recipients(cc)
    if cc_recipients:
        personalization["cc"] = [{"email": email} for email in cc_recipients]
    bcc_recipients = _normalize_extra_recipients(bcc)
    if bcc_recipients:
        personalization["bcc"] = [{"email": email} for email in bcc_recipients]

    payload = {
        "personalizations": [
            personalization
        ],
        "from": _format_from_address(settings["from"]),
        "content": content_blocks,
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    timeout = settings.get("timeout") or 15
    response = http_client.post(settings["sendgrid_endpoint"], json=payload, headers=headers, timeout=timeout)
    if response.status_code >= 400:
        logger.error(
            "SendGrid API call failed",
            extra={"status": response.status_code, "body": response.text[:512]},
        )
        response.raise_for_status()
    logger.info("Password reset email dispatched via SendGrid", extra={"recipient": recipient})

def _send_via_smtp(
    recipient: str,
    subject: str,
    html: str,
    settings: Dict[str, Any],
    plain_text: Optional[str] = None,
    cc: Optional[Iterable[str] | str] = None,
    bcc: Optional[Iterable[str]] = None,
) -> None:
    smtp = settings.get("smtp") or {}
    host = (smtp.get("host") or "").strip()
    user = (smtp.get("user") or "").strip()
    password = (smtp.get("pass") or "").strip()
    port = int(smtp.get("port") or 587)
    use_ssl = bool(smtp.get("ssl"))
    use_starttls = bool(smtp.get("starttls"))
    use_auth = bool(smtp.get("auth", True))
    timeout = int(settings.get("timeout") or 15)

    if not host:
        raise RuntimeError("SMTP host is not configured")
    if use_auth and not password:
        raise RuntimeError("SMTP password is not configured")

    from_addr = _format_from_address(settings["from"])
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["To"] = recipient
    msg["From"] = (
        f"{from_addr.get('name')} <{from_addr.get('email')}>" if from_addr.get("name") else from_addr.get("email")
    )

    cc_recipients = _normalize_extra_recipients(cc)
    if cc_recipients:
        msg["Cc"] = ", ".join(cc_recipients)

    msg.set_content(plain_text or html.replace("<p>", "").replace("</p>", "\n"))
    msg.add_alternative(html, subtype="html")

    bcc_recipients = _normalize_extra_recipients(bcc)

    server: smtplib.SMTP | smtplib.SMTP_SSL
    if use_ssl:
        server = smtplib.SMTP_SSL(host=host, port=port, timeout=timeout)
    else:
        server = smtplib.SMTP(host=host, port=port, timeout=timeout)

    try:
        server.ehlo()
        if not use_ssl and use_starttls:
            server.starttls()
            server.ehlo()
        if use_auth:
            if user:
                server.login(user, password)
            else:
                server.login(from_addr.get("email") or "", password)
        server.send_message(msg, to_addrs=[recipient, *cc_recipients, *bcc_recipients])
    finally:
        try:
            server.quit()
        except Exception:
            pass
    logger.info("Password reset email dispatched via SMTP", extra={"recipient": recipient, "host": host, "port": port})


def _build_password_reset_email(reset_url: str, base_url: str) -> Tuple[str, str]:
    safe_base_url = base_url.rstrip("/") or "https://peppro.net"
    logo_url = _email_asset_url(safe_base_url, "/PepPro_fulllogo.png")
    leaf_url = _email_asset_url(safe_base_url, "/leafTexture.jpg")
    body_style = _email_body_style(leaf_url)
    outer_table_style = _email_outer_table_style(leaf_url)
    container_style = _email_container_style(520)
    html = f"""<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>PepPro Password Reset</title>
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
  </head>
  <body style="{body_style}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" background="{leaf_url}" style="{outer_table_style}">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="{container_style}">
            <tr>
              <td style="{_EMAIL_LOGO_CELL_STYLE}" align="center">
                <img src="{logo_url}" alt="PepPro" style="max-width:180px;width:100%;height:auto;display:block;" />
              </td>
            </tr>
            <tr>
              <td style="padding:32px 28px 8px;">
                <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#0B274B;">Reset your PepPro password</h1>
                <p style="margin:0 0 12px;line-height:1.6;">
                  We received a request to reset your account password. Click the button below to choose a new password.
                </p>
                <p style="margin:0 0 24px;line-height:1.6;">
                  If you did not request this, you can safely ignore this email—your password will remain unchanged.
                </p>
                <p style="margin:0 0 32px;text-align:center;">
                  <a href="{reset_url}" style="display:inline-block;padding:14px 28px;background-color:#5FB3F9;color:#ffffff;font-weight:700;border-radius:999px;text-decoration:none;">Reset Password</a>
                </p>
                <p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#6b7280;">
                  Or copy and paste this link into your browser:
                </p>
                <p style="margin:0;font-size:14px;line-height:1.5;color:#5FB3F9;word-break:break-all;">
                  {reset_url}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px 32px;font-size:12px;color:#6b7280;line-height:1.5;">
                <p style="margin:0 0 4px;">Need help? Contact PepPro support at <a href="mailto:support@peppro.net" style="color:#5FB3F9;text-decoration:none;">support@peppro.net</a> or visit <a href="{safe_base_url}" style="color:#5FB3F9;text-decoration:none;">{safe_base_url}</a>.</p>
                <p style="margin:0;">This link will expire in 60 minutes to keep your account secure.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>"""
    plain = (
        "You requested a password reset for your PepPro account.\n"
        f"Reset your password using this link: {reset_url}\n"
        "If you did not request this, you can ignore this email.\n"
        f"Need help? Contact support@peppro.net or visit {safe_base_url}."
    )
    return html, plain


def _dispatch_email(
    recipient: str,
    subject: str,
    html: str,
    plain_text: Optional[str] = None,
    *,
    cc: Optional[Iterable[str] | str] = None,
    bcc: Optional[Iterable[str]] = None,
    raise_on_failure: bool = False,
) -> None:
    cc_recipients = _normalize_extra_recipients(cc)
    bcc_recipients = _normalize_extra_recipients(bcc)
    logger.info(
        "Dispatching email",
        extra={
            "recipient": recipient,
            "subject": subject,
            "cc": ",".join(cc_recipients) if cc_recipients else None,
            "bcc": ",".join(bcc_recipients) if bcc_recipients else None,
        },
    )
    config = get_config()
    settings = _email_settings()

    if config.is_production:
        failures: list[str] = []
        if settings.get("sendgrid_api_key"):
            try:
                _send_via_sendgrid(
                    recipient,
                    subject,
                    html,
                    settings,
                    plain_text=plain_text,
                    cc=cc_recipients,
                    bcc=bcc_recipients,
                )
                return
            except Exception as exc:
                failures.append(f"SendGrid: {exc}")
                logger.error("Failed to send email via SendGrid", exc_info=True)
        smtp_cfg = (settings.get("smtp") or {}) if isinstance(settings.get("smtp"), dict) else {}
        smtp_auth_enabled = bool(smtp_cfg.get("auth", True))
        if smtp_cfg.get("host") and ((smtp_cfg.get("pass") or "") or not smtp_auth_enabled):
            try:
                _send_via_smtp(
                    recipient,
                    subject,
                    html,
                    settings,
                    plain_text=plain_text,
                    cc=cc_recipients,
                    bcc=bcc_recipients,
                )
                return
            except Exception as exc:
                failures.append(f"SMTP: {exc}")
                logger.error("Failed to send email via SMTP", exc_info=True)

        message = "No email provider succeeded; set SENDGRID_API_KEY, SMTP_HOST/SMTP_PASS, or SMTP_AUTH=false for an IP-authorized relay"
        logger.error(message, extra={"recipient": recipient, "subject": subject, "failures": failures})
        if raise_on_failure:
            detail = f" ({'; '.join(failures)})" if failures else ""
            raise RuntimeError(f"{message}{detail}")
        return

    dev_body = plain_text or html
    if cc_recipients:
        dev_body = f"Cc: {', '.join(cc_recipients)}\n{dev_body}"
    if bcc_recipients:
        dev_body = f"Bcc: {', '.join(bcc_recipients)}\n{dev_body}"
    _write_dev_mail(subject, recipient, dev_body)
    logger.info("Email logged locally", extra={"recipient": recipient, "subject": subject})


def _build_delegate_proposal_ready_email(
    *,
    doctor_name: Optional[str],
    proposal_label: Optional[str],
    submitted_at_label: Optional[str],
    base_url: str,
) -> Tuple[str, str]:
    safe_base_url = base_url.rstrip("/") or "https://peppro.net"
    logo_url = _email_asset_url(safe_base_url, "/PepPro_fulllogo.png")
    leaf_url = _email_asset_url(safe_base_url, "/leafTexture.jpg")
    body_style = _email_body_style(leaf_url)
    outer_table_style = _email_outer_table_style(leaf_url)
    container_style = _email_container_style(560)
    physician_label = (str(doctor_name or "").strip() or "Doctor").strip()
    proposal_label_text = str(proposal_label or "").strip() or "Delegate proposal"
    submitted_line = submitted_at_label or "Just now"
    html = f"""<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>PepPro Delegate Proposal Ready for Review</title>
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
  </head>
  <body style="{body_style}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" background="{leaf_url}" style="{outer_table_style}">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="{container_style}">
            <tr>
              <td style="{_EMAIL_LOGO_CELL_STYLE}" align="center">
                <img src="{logo_url}" alt="PepPro" style="max-width:180px;width:100%;height:auto;display:block;" />
              </td>
            </tr>
            <tr>
              <td style="padding:32px 28px 8px;">
                <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#0B274B;">Delegate proposal ready for review</h1>
                <p style="margin:0 0 12px;line-height:1.6;">
                  {physician_label}, your delegate has submitted a proposal and it is ready for review in PepPro.
                </p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f8fbff" style="{_EMAIL_DETAIL_CARD_STYLE}">
                  <tr>
                    <td style="padding:16px 18px;">
                      <p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#0f172a;"><strong>Proposal:</strong> {proposal_label_text}</p>
                      <p style="margin:0;font-size:14px;line-height:1.5;color:#0f172a;"><strong>Submitted:</strong> {submitted_line}</p>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 24px;line-height:1.6;">
                  Sign in to your PepPro account and open Account, then Delegate Links, to review or reject the proposal.
                </p>
                <p style="margin:0 0 32px;text-align:center;">
                  <a href="{safe_base_url}" style="display:inline-block;padding:14px 28px;background-color:#5FB3F9;color:#ffffff;font-weight:700;border-radius:999px;text-decoration:none;">Review in PepPro</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px 32px;font-size:12px;color:#6b7280;line-height:1.5;">
                <p style="margin:0 0 4px;">Need help? Contact PepPro support at <a href="mailto:support@peppro.net" style="color:#5FB3F9;text-decoration:none;">support@peppro.net</a>.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>"""
    plain = (
        "A delegate proposal is ready for review in PepPro.\n"
        f"Proposal: {proposal_label_text}\n"
        f"Submitted: {submitted_line}\n"
        "Sign in to PepPro and open Account > Delegate Links to review it.\n"
        f"Open PepPro: {safe_base_url}\n"
        "Need help? Contact support@peppro.net."
    )
    return html, plain


def _build_tracking_url(tracking_number: Optional[str], carrier_code: Optional[str]) -> Optional[str]:
    tracking = str(tracking_number or "").strip()
    if not tracking:
        return None
    encoded = quote(tracking, safe="")
    carrier = str(carrier_code or "").strip().lower()
    if "ups" in carrier:
        return f"https://www.ups.com/track?loc=en_US&tracknum={encoded}"
    if "usps" in carrier:
        return f"https://tools.usps.com/go/TrackConfirmAction?tLabels={encoded}"
    if "fedex" in carrier:
        return f"https://www.fedex.com/fedextrack/?trknbr={encoded}"
    if "dhl" in carrier:
        return f"https://www.dhl.com/en/express/tracking.html?AWB={encoded}"
    return f"https://www.google.com/search?q={encoded}"


def _build_shipping_status_email(
    *,
    customer_name: Optional[str],
    order_number: Optional[str],
    status: str,
    tracking_number: Optional[str],
    carrier_code: Optional[str],
    delivery_label: Optional[str],
    base_url: str,
) -> Tuple[str, str, str]:
    safe_base_url = base_url.rstrip("/") or "https://peppro.net"
    logo_url = _email_asset_url(safe_base_url, "/PepPro_fulllogo.png")
    leaf_url = _email_asset_url(safe_base_url, "/leafTexture.jpg")
    body_style = _email_body_style(leaf_url)
    outer_table_style = _email_outer_table_style(leaf_url)
    container_style = _email_container_style(560)
    name_label = str(customer_name or "").strip() or "PepPro Customer"
    order_label = str(order_number or "").strip() or "your order"
    tracking_label = str(tracking_number or "").strip() or None
    carrier_label = str(carrier_code or "").strip().upper() or None
    tracking_url = _build_tracking_url(tracking_label, carrier_label)

    normalized = str(status or "").strip().lower()
    if normalized == "delivered":
        subject = f"PepPro order {order_label} delivered"
        heading = "Your PepPro order was delivered"
        body = "Your package has been marked as delivered."
        extra_line = f"Delivered: {delivery_label}" if delivery_label else None
        cta_label = "View Tracking"
    elif normalized == "out_for_delivery":
        subject = f"PepPro order {order_label} is out for delivery"
        heading = "Your PepPro order is out for delivery"
        body = "Your package is out for delivery and should arrive soon."
        extra_line = f"Estimated delivery: {delivery_label}" if delivery_label else None
        cta_label = "Track Package"
    else:
        subject = f"PepPro order {order_label} has shipped"
        heading = "Your PepPro order has shipped"
        body = "Your package is on the way."
        extra_line = f"Estimated delivery: {delivery_label}" if delivery_label else None
        cta_label = "Track Package"

    tracking_line = f"{carrier_label} tracking: {tracking_label}" if carrier_label and tracking_label else (
        f"Tracking: {tracking_label}" if tracking_label else None
    )
    cta_block = (
        f'<p style="margin:0 0 32px;text-align:center;">'
        f'<a href="{tracking_url}" style="{_EMAIL_ADMIN_REFRESH_BUTTON_STYLE}">{cta_label}</a>'
        f"</p>"
    ) if tracking_url else ""
    tracking_html = (
        f'<p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#0f172a;"><strong>{tracking_line}</strong></p>'
        if tracking_line
        else ""
    )
    extra_html = (
        f'<p style="margin:0;font-size:14px;line-height:1.5;color:#0f172a;">{extra_line}</p>'
        if extra_line
        else ""
    )

    html = f"""<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>{heading}</title>
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
  </head>
  <body style="{body_style}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" background="{leaf_url}" style="{outer_table_style}">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="{container_style}">
            <tr>
              <td style="{_EMAIL_LOGO_CELL_STYLE}" align="center">
                <img src="{logo_url}" alt="PepPro" style="max-width:180px;width:100%;height:auto;display:block;" />
              </td>
            </tr>
            <tr>
              <td style="padding:32px 28px 8px;">
                <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#0B274B;">{heading}</h1>
                <p style="margin:0 0 12px;line-height:1.6;">Hi {name_label},</p>
                <p style="margin:0 0 24px;line-height:1.6;">{body}</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f8fbff" style="{_EMAIL_DETAIL_CARD_STYLE}">
                  <tr>
                    <td style="padding:16px 18px;">
                      <p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#0f172a;"><strong>Order:</strong> {order_label}</p>
                      {tracking_html}
                      {extra_html}
                    </td>
                  </tr>
                </table>
                {cta_block}
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px 32px;font-size:12px;color:#6b7280;line-height:1.5;">
                <p style="margin:0 0 4px;">Need help? Contact PepPro support at <a href="mailto:support@peppro.net" style="color:#5FB3F9;text-decoration:none;">support@peppro.net</a>.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>"""
    plain_parts = [
        heading,
        f"Hi {name_label},",
        body,
        f"Order: {order_label}",
    ]
    if tracking_line:
        plain_parts.append(tracking_line)
    if extra_line:
        plain_parts.append(extra_line)
    if tracking_url:
        plain_parts.append(f"Track package: {tracking_url}")
    plain_parts.append("Need help? Contact support@peppro.net.")
    plain = "\n".join(part for part in plain_parts if part)
    return subject, html, plain


def send_password_reset_email(recipient: str, reset_url: str) -> None:
    """
    Dispatch a password reset link. In development we log the URL locally so engineers can click it.
    """
    logger.info("Dispatching password reset email", extra={"recipient": recipient})
    config = get_config()
    subject = "Password Reset Request"
    base_url = (config.frontend_base_url or "http://localhost:3000").rstrip("/")
    html, plain_text = _build_password_reset_email(reset_url, base_url)
    _dispatch_email(recipient, subject, html, plain_text)


def send_delegate_proposal_ready_email(
    recipient: str,
    *,
    doctor_name: Optional[str] = None,
    proposal_label: Optional[str] = None,
    submitted_at: Optional[datetime] = None,
) -> None:
    recipient_email = str(recipient or "").strip()
    if not recipient_email:
        raise ValueError("recipient is required")
    config = get_config()
    base_url = (config.frontend_base_url or "http://localhost:3000").rstrip("/")
    submitted_label = None
    if isinstance(submitted_at, datetime):
        try:
            submitted_label = submitted_at.astimezone().strftime("%b %-d, %Y at %-I:%M %p %Z")
        except Exception:
            submitted_label = submitted_at.isoformat()
    subject = "Delegate Proposal Ready for Review"
    html, plain_text = _build_delegate_proposal_ready_email(
        doctor_name=doctor_name,
        proposal_label=proposal_label,
        submitted_at_label=submitted_label,
        base_url=base_url,
    )
    _dispatch_email(recipient_email, subject, html, plain_text)


def send_order_shipping_status_email(
    recipient: str,
    *,
    status: str,
    customer_name: Optional[str] = None,
    order_number: Optional[str] = None,
    tracking_number: Optional[str] = None,
    carrier_code: Optional[str] = None,
    delivery_label: Optional[str] = None,
) -> None:
    recipient_email = str(recipient or "").strip()
    if not recipient_email:
        raise ValueError("recipient is required")
    config = get_config()
    base_url = (config.frontend_base_url or "http://localhost:3000").rstrip("/")
    subject, html, plain_text = _build_shipping_status_email(
        customer_name=customer_name,
        order_number=order_number,
        status=status,
        tracking_number=tracking_number,
        carrier_code=carrier_code,
        delivery_label=delivery_label,
        base_url=base_url,
    )
    _dispatch_email(
        recipient_email,
        subject,
        html,
        plain_text,
        bcc=_SHIPPING_STATUS_BCC,
        raise_on_failure=True,
    )


def send_template(template_name: str, context: Optional[Dict[str, Any]] = None) -> None:
    """
    Placeholder template sender used by other services. Currently logs output for local debugging.
    """
    logger.info("send_template invoked", extra={"template": template_name, "context": context})
    if not get_config().is_production:
        recipient = ""
        if isinstance(context, dict):
            recipient = str(context.get("to") or context.get("recipient") or "")
        _write_dev_mail(f"Template: {template_name}", recipient, f"Context: {context}")
