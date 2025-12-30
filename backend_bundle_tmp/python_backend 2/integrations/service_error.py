class ServiceError(RuntimeError):
    """Lightweight exception wrapper for webhook failures."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status
