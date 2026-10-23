"""ESP32s on the same Wi-Fi show up under Add node and are connected from the website."""
from .conftest import ADMIN, VIEWER, payload

MAC = "24:6F:28:AA:BB:CC"
SECRET = "a1b2c3d4e5f6a7b8c9d0"
HOME = {"X-Forwarded-For": "81.2.69.142"}      # the router's public IP (cloud-hosted API)
ELSEWHERE = {"X-Forwarded-For": "8.8.4.4"}


def announce(api, mac=MAC, secret=SECRET, headers=HOME, **extra):
    body = {"mac": mac, "claim_secret": secret, "firmware": "2.0.0", "rssi": -51, "local_ip": "192.168.1.40", **extra}
    return api.post("/api/devices/announce", json=body, headers=headers)


def reading(node, **extra):
    body = payload(node=node)
    body.pop("location")  # paired firmware leaves the location to the website
    return {**body, **extra}


def test_discovered_device_is_connected_and_reports(api):
    r = announce(api)
    assert r.status_code == 200 and r.json()["status"] == "waiting"
    assert r.json()["suggested_node_id"] == "ESP32-AABBCC"
    announce(api, mac="24:6F:28:00:00:01", secret="z" * 20, headers=ELSEWHERE)

    api.login(ADMIN)
    found = api.get("/api/devices/discovered", headers=HOME).json()
    assert [d["mac"] for d in found["items"]] == [MAC] and found["other_networks"] == 1
    assert found["items"][0]["same_network"] is True and found["items"][0]["local_ip"] == "192.168.1.40"
    every = api.get("/api/devices/discovered", params={"scope": "all"}, headers=HOME).json()["items"]
    assert len(every) == 2

    r = api.post(f"/api/devices/{MAC}/approve", json={"node_id": "esp32-aabbcc", "location": "Ground floor - column C2"})
    assert r.status_code == 201, r.text
    assert r.json()["node_id"] == "ESP32-AABBCC" and r.json()["online"] is False and "device_key" not in r.json()
    assert api.get("/api/devices/discovered", headers=HOME).json()["items"] == []
    assert api.post(f"/api/devices/{MAC}/approve", json={"node_id": "OTHER-01"}).status_code == 404

    # the device's next announce hands it its node ID and key
    got = announce(api).json()
    assert got["status"] == "approved" and got["node_id"] == "ESP32-AABBCC"
    assert got["location"] == "Ground floor - column C2"
    key = got["device_key"]
    assert announce(api).json()["device_key"] == key  # repeated until the device actually uses it

    r = api.post("/api/ingest", json=reading("ESP32-AABBCC"), headers={"X-Device-Key": key})
    assert r.status_code == 200, r.text
    node = next(n for n in api.get("/api/nodes").json()["items"] if n["node_id"] == "ESP32-AABBCC")
    assert node["online"] is True and node["location"] == "Ground floor - column C2"
    assert announce(api).json()["status"] == "waiting"  # pairing entry is gone once the key is in use

    # the key only works for its own node
    assert api.post("/api/ingest", json=reading("ESP32-OTHER"), headers={"X-Device-Key": key}).status_code == 401
    # deleting the node revokes the key; the board then announces again and is listed again
    assert api.delete("/api/nodes/ESP32-AABBCC").status_code == 204
    assert api.post("/api/ingest", json=reading("ESP32-AABBCC"), headers={"X-Device-Key": key}).status_code == 401


def test_paired_node_can_belong_to_a_user(api):
    api.login(ADMIN)
    owner = api.post("/api/users", json={"email": "pairing.owner@gmail.com", "password": "Owner-pass-2026", "name": "O"}).json()["id"]
    announce(api)
    assert api.post(f"/api/devices/{MAC}/approve", json={"node_id": "OWN-01", "owner_id": owner}).status_code == 201
    key = announce(api).json()["device_key"]
    assert api.post("/api/ingest", json=reading("OWN-01"), headers={"X-Device-Key": key}).status_code == 200
    api.post("/api/auth/logout")
    api.login({"email": "pairing.owner@gmail.com", "password": "Owner-pass-2026"})
    assert [n["node_id"] for n in api.get("/api/telemetry").json()["nodes"]] == ["OWN-01"]


def test_claim_secret_protects_a_waiting_device(api):
    assert announce(api).status_code == 200
    assert announce(api, secret="x" * 20).status_code == 409  # someone else claiming the same MAC
    assert announce(api, mac="not-a-mac").status_code == 422
    assert announce(api, secret="short").status_code == 422


def test_existing_node_id_is_refused(api):
    api.login(ADMIN)
    announce(api)
    assert api.post("/api/nodes", json={"node_id": "TAKEN-01"}).status_code == 201
    assert api.post(f"/api/devices/{MAC}/approve", json={"node_id": "TAKEN-01"}).status_code == 409


def test_local_network_api_lists_lan_devices(api):
    """API running on a PC: the ESP32 and the admin's browser both have private addresses."""
    announce(api, headers={"X-Forwarded-For": "192.168.1.40"})
    api.login(ADMIN)
    items = api.get("/api/devices/discovered", headers={"X-Forwarded-For": "192.168.1.10"}).json()["items"]
    assert [d["mac"] for d in items] == [MAC]


def test_only_admins_see_and_connect_devices(api):
    announce(api)
    api.login(VIEWER)
    assert api.get("/api/devices/discovered").status_code == 403
    assert api.post(f"/api/devices/{MAC}/approve", json={"node_id": "X-01"}).status_code == 403
