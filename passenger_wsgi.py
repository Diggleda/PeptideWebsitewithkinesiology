from __future__ import annotations

from python_backend.wsgi import app as application

# Some local runners/importers expect `app`; Passenger commonly looks for
# `application`. Expose both to keep the entrypoint tolerant.
app = application
