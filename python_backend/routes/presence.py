from __future__ import annotations

from flask import Blueprint

from . import settings

blueprint = Blueprint("presence", __name__, url_prefix="/api/settings")

blueprint.add_url_rule(
    "/live-clients/longpoll",
    endpoint="live_clients_longpoll",
    view_func=settings.longpoll_live_clients,
    methods=["GET"],
)
blueprint.add_url_rule(
    "/live-users/longpoll",
    endpoint="live_users_longpoll",
    view_func=settings.longpoll_live_users,
    methods=["GET"],
)
blueprint.add_url_rule(
    "/user-activity/longpoll",
    endpoint="user_activity_longpoll",
    view_func=settings.longpoll_user_activity,
    methods=["GET"],
)
