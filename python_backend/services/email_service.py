from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
import logging

import requests

from . import get_config

logger = logging.getLogger(__name__)

SENDGRID_ENDPOINT = "https://api.sendgrid.com/v3/mail/send"
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

    api_key = (
        os.environ.get("SENDGRID_API_KEY")
        or os.environ.get("SENDGRID_API_TOKEN")
        or os.environ.get("SMTP_PASS")
        or os.environ.get("EMAIL_PASS")
    )
    settings = {
        "from": os.environ.get("MAIL_FROM") or "PepPro <support@peppro.net>",
        "timeout": _to_int(os.environ.get("SENDGRID_TIMEOUT") or os.environ.get("SMTP_TIMEOUT"), 15),
        "api_key": api_key,
        "endpoint": os.environ.get("SENDGRID_API_URL") or SENDGRID_ENDPOINT,
    }
    logger.info(
        "Loaded email settings",
        extra={"from": settings["from"], "hasSendGridKey": bool(settings["api_key"]), "endpoint": settings["endpoint"]},
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


def _send_via_sendgrid(
    recipient: str,
    subject: str,
    html: str,
    settings: Dict[str, Any],
    plain_text: Optional[str] = None,
) -> None:
    api_key = settings.get("api_key")
    if not api_key:
        logger.warning("SendGrid API key missing, falling back to dev logging")
        raise RuntimeError("SendGrid API key is not configured")

    content_blocks = []
    if plain_text:
        content_blocks.append({"type": "text/plain", "value": plain_text})
    else:
        content_blocks.append({"type": "text/plain", "value": html.replace("<p>", "").replace("</p>", "\n")})
    content_blocks.append({"type": "text/html", "value": html})

    payload = {
        "personalizations": [
            {
                "to": [{"email": recipient}],
                "subject": subject,
            }
        ],
        "from": _format_from_address(settings["from"]),
        "content": content_blocks,
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    timeout = settings.get("timeout") or 15
    response = requests.post(settings["endpoint"], json=payload, headers=headers, timeout=timeout)
    if response.status_code >= 400:
        logger.error(
            "SendGrid API call failed",
            extra={"status": response.status_code, "body": response.text[:512]},
        )
        response.raise_for_status()
    logger.info("Password reset email dispatched via SendGrid", extra={"recipient": recipient})


def _build_password_reset_email(reset_url: str, base_url: str) -> Tuple[str, str]:
    safe_base_url = base_url.rstrip("/") or "https://peppro.net"
    html = f"""<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>PepPro Password Reset</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f6f8;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 10px 30px rgba(15,23,42,0.08);">
            <tr>
              <td style="background-color:#ffffff;padding:24px 24px 12px;" align="center">
                <img src="{PEPPRO_LOGO_DATA_URI}" alt="PepPro" style="max-width:180px;width:100%;height:auto;display:block;" />
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
                  <a href="{reset_url}" style="display:inline-block;padding:14px 28px;background-color:#0B274B;color:#ffffff;font-weight:600;border-radius:999px;text-decoration:none;">Reset Password</a>
                </p>
                <p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#6b7280;">
                  Or copy and paste this link into your browser:
                </p>
                <p style="margin:0;font-size:14px;line-height:1.5;color:#1d4ed8;word-break:break-all;">
                  {reset_url}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px 32px;font-size:12px;color:#6b7280;line-height:1.5;">
                <p style="margin:0 0 4px;">Need help? Contact PepPro support at <a href="mailto:support@peppro.net" style="color:#0B274B;text-decoration:none;">support@peppro.net</a> or visit <a href="{safe_base_url}" style="color:#0B274B;text-decoration:none;">{safe_base_url}</a>.</p>
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


def send_password_reset_email(recipient: str, reset_url: str) -> None:
    """
    Dispatch a password reset link. In development we log the URL locally so engineers can click it.
    """
    logger.info("Dispatching password reset email", extra={"recipient": recipient, "reset_url": reset_url})
    config = get_config()
    subject = "Password Reset Request"
    base_url = (config.frontend_base_url or "http://localhost:3000").rstrip("/")
    html, plain_text = _build_password_reset_email(reset_url, base_url)
    settings = _email_settings()

    if config.is_production:
        try:
            _send_via_sendgrid(recipient, subject, html, settings, plain_text=plain_text)
            return
        except Exception:
            logger.error("Failed to send password reset email", exc_info=True)

    _write_dev_mail(subject, recipient, plain_text)
    logger.info("Password reset email logged locally", extra={"recipient": recipient})


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
