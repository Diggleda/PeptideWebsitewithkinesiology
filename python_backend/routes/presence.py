from __future__ import annotations

from flask import Blueprint

from . import settings

blueprint = Blueprint("presence", __name__, url_prefix="/api/settings")

blueprint.add_url_rule(
    "/presence",
    endpoint="record_presence",
    view_func=settings.record_presence,
    methods=["POST"],
)
blueprint.add_url_rule(
    "/live-clients",
    endpoint="live_clients",
    view_func=settings.get_live_clients,
    methods=["GET"],
)
blueprint.add_url_rule(
    "/live-clients/longpoll",
    endpoint="live_clients_longpoll",
    view_func=settings.longpoll_live_clients,
    methods=["GET"],
)
blueprint.add_url_rule(
    "/live-users",
    endpoint="live_users",
    view_func=settings.get_live_users,
    methods=["GET"],
)
blueprint.add_url_rule(
    "/live-users/longpoll",
    endpoint="live_users_longpoll",
    view_func=settings.longpoll_live_users,
    methods=["GET"],
)
blueprint.add_url_rule(
    "/user-activity",
    endpoint="user_activity",
    view_func=settings.get_user_activity,
    methods=["GET"],
)
blueprint.add_url_rule(
    "/user-activity/longpoll",
    endpoint="user_activity_longpoll",
    view_func=settings.longpoll_user_activity,
    methods=["GET"],
)
