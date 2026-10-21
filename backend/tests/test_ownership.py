"""Each account sees only the ESP32s it connected with its personal device key (admins see all)."""
from .conftest import ADMIN, DEVICE_KEY, Api, payload

ALICE = {"email": "alice.builder@gmail.com", "password": "Alice-pass-2026", "name": "Alice"}
BOB = {"email": "bob.engineer@gmail.com", "password": "Bob-pass-2026", "name": "Bob"}


def _make_users(api: Api):
    api.login(ADMIN)
    for u in (ALICE, BOB):
        r = api.post("/api/users", json={**u, "role": "viewer"})
        assert r.status_code == 201, r.text
    api.post("/api/auth/logout")


def _key_of(api: Api, who) -> str:
    api.login(who)
    return api.get("/api/profile/device").json()["device_key"]


def _send(api: Api, key, node, **readings):
    body = payload(node=node, **readings)
    return api.post("/api/ingest", json=body, headers={"X-Device-Key": key})


def _visible(api: Api):
    t = api.get("/api/telemetry").json()
    return sorted(n["node_id"] for n in t["nodes"]), t


def test_a_new_account_sees_no_nodes_until_its_own_device_reports(api):
    _make_users(api)
    a_key = _key_of(api, ALICE)
    assert a_key.startswith("shm_") and api.get("/api/profile/device").json()["device_key"] == a_key  # stable
    ids, t = _visible(api)
    assert ids == [] and t["total_nodes"] == 0 and t["connection"] == "no_data"  # not the site's demo building
    assert all(p["readings"] == [] for p in t["parameters"])

    assert _send(api, a_key, "ALICE-01", strain=700).status_code == 200  # breach -> an alert for Alice
    assert _send(api, DEVICE_KEY, "SITE-01", strain=800).status_code == 200  # the site's own device
    api.drain()
    ids, t = _visible(api)
    assert ids == ["ALICE-01"] and t["open_alerts"] == 1 and t["connection"] == "healthy"
    assert {a["node_id"] for a in api.get("/api/events").json()["items"]} == {"ALICE-01"}
    assert {r["node_id"] for r in api.get("/api/telemetry/history").json()["items"]} == {"ALICE-01"}
    assert [n["node_id"] for n in api.get("/api/nodes").json()["items"]] == ["ALICE-01"]
    assert api.get("/api/nodes/SITE-01").status_code == 404
    assert api.get("/api/telemetry/history", params={"node_id": "SITE-01"}).json()["items"] == []
    assert api.get("/api/profile/device").json()["nodes"] == ["ALICE-01"]

    api.login(BOB)
    assert _visible(api)[0] == []  # Bob sees neither Alice's node nor the site's
    assert api.get("/api/events").json()["items"] == []

    api.login(ADMIN)
    ids = _visible(api)[0]
    assert "ALICE-01" in ids and "SITE-01" in ids  # the admin sees every node


def test_a_node_id_cannot_be_taken_over(api):
    _make_users(api)
    a_key, b_key = _key_of(api, ALICE), _key_of(api, BOB)
    assert _send(api, a_key, "SHARED-NAME").status_code == 200
    r = _send(api, b_key, "SHARED-NAME")
    assert r.status_code == 409 and "different NODE_ID" in r.json()["detail"]
    assert _send(api, DEVICE_KEY, "SHARED-NAME").status_code == 409  # not even with the site-wide key
    assert _send(api, a_key, "ESP32-01").status_code == 409  # nor the site's own (demo) nodes


def test_rotating_the_key_disconnects_the_old_one(api):
    _make_users(api)
    old = _key_of(api, ALICE)
    assert _send(api, old, "ALICE-02").status_code == 200
    new = api.post("/api/profile/device/rotate").json()["device_key"]
    assert new != old and new.startswith("shm_")
    assert _send(api, old, "ALICE-02").status_code == 401
    assert _send(api, new, "ALICE-02").status_code == 200  # the node stays Alice's


def test_a_disabled_account_cannot_send(api):
    _make_users(api)
    key = _key_of(api, BOB)
    api.login(ADMIN)
    bob_id = next(u["id"] for u in api.get("/api/users").json()["items"] if u["email"] == BOB["email"])
    assert api.put(f"/api/users/{bob_id}", json={"active": False}).status_code == 200
    r = _send(api, key, "BOB-01")
    assert r.status_code == 401 and "disabled" in r.json()["detail"]


def test_device_keys_are_never_listed(api):
    _make_users(api)
    _key_of(api, ALICE)
    api.login(ADMIN)
    assert all("device_key" not in u for u in api.get("/api/users").json()["items"])
    assert "device_key" not in api.get("/api/auth/me").json().get("user", {})
