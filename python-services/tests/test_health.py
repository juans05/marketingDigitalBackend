from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def test_root_returns_200_for_railway_default_healthcheck():
    res = client.get("/")
    assert res.status_code == 200


def test_health_endpoint_returns_200():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"
