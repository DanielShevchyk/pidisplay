import pytest


@pytest.fixture(autouse=True)
def no_pidisplay(monkeypatch):
    """Tests never ask a real PiDisplay for check-in weigh-ins; the ones about them pass a stand-in."""
    monkeypatch.setenv("PIDISPLAY_URL", "")
