"""Administrators register, place, re-assign and delete nodes, and can look at one account's building."""
from .conftest import ADMIN, DEVICE_KEY, VIEWER, Api, payload

OWNER = {"email": "site.owner@gmail.com", "password": "Owner-pass-2026", "name": "Owner"}


def _owner_id(api: Api) -> str:
    r = api.post("/api/users", json={**OWNER, "role": "viewer"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_admin_registers_a_node_before_it_reports(api):
    api.login(ADMIN)
    owner = _owner_id(api)
    r = api.post("/api/nodes", json={"node_id": "plan-01", "location": "Column C2", "floor": "2nd floor",
                                     "plan_x": 25, "plan_y": 60, "owner_id": owner})
    assert r.status_code == 201, r.text
    n = r.json()
    assert n["node_id"] == "PLAN-01" and n["floor"] == 2 and n["plan_x"] == 25 and n["online"] is False
    assert api.post("/api/nodes", json={"node_id": "PLAN-01"}).status_code == 409
    assert api.post("/api/nodes", json={"node_id": "PLAN-02", "owner_id": "usr_nobody"}).status_code == 422
    listed = {x["node_id"]: x for x in api.get("/api/nodes").json()["items"]}
    assert listed["PLAN-01"]["owner_email"] == OWNER["email"]
    assert next(u for u in api.get("/api/users").json()["items"] if u["id"] == owner)["node_count"] == 1

    # the owner's device then reports into the registered node and keeps its spot on the plan
    api.post("/api/auth/logout")
    api.login(OWNER)
    key = api.get("/api/profile/device").json()["device_key"]
    r = api.post("/api/ingest", json=payload(node="PLAN-01", strain=300), headers={"X-Device-Key": key})
    assert r.status_code == 200, r.text
    mine = api.get("/api/telemetry").json()["nodes"]
    assert [(m["node_id"], m["plan_x"], m["plan_y"], m["online"]) for m in mine] == [("PLAN-01", 25, 60, True)]


def test_admin_edits_moves_and_deletes_a_node(api):
    api.login(ADMIN)
    assert api.post("/api/ingest", json=payload(node="EDIT-01", strain=900), headers={"X-Device-Key": DEVICE_KEY}).status_code == 200
    r = api.patch("/api/nodes/edit-01", json={"floor": "roof", "plan_x": 80, "plan_y": 10, "location": "Water tank frame"})
    assert r.status_code == 200 and r.json()["floor"] == "roof" and r.json()["plan_x"] == 80
    r = api.patch("/api/nodes/EDIT-01", json={"floor": None})  # back to reading the floor from the location text
    assert r.json()["floor"] is None and r.json()["location"] == "Water tank frame"
    assert api.patch("/api/nodes/EDIT-01", json={"plan_x": 120}).status_code == 422
    assert api.patch("/api/nodes/NOPE-01", json={"plan_x": 10}).status_code == 404

    alerts = api.get("/api/events", params={"node_id": "EDIT-01"}).json()["total"]
    assert api.delete("/api/nodes/EDIT-01").status_code == 204
    assert api.get("/api/nodes/EDIT-01").status_code == 404
    assert api.get("/api/events", params={"node_id": "EDIT-01"}).json()["total"] == alerts  # history is kept
    assert api.delete("/api/nodes/EDIT-01").status_code == 404


def test_only_admins_manage_nodes(api):
    api.login(VIEWER)
    assert api.post("/api/nodes", json={"node_id": "X-01"}).status_code == 403
    assert api.patch("/api/nodes/ESP32-01", json={"plan_x": 5}).status_code == 403
    assert api.delete("/api/nodes/ESP32-01").status_code == 403


def test_admin_sees_one_accounts_building(api):
    api.login(ADMIN)
    owner = _owner_id(api)
    api.post("/api/nodes", json={"node_id": "OWN-01", "location": "3rd floor slab", "owner_id": owner})
    t = api.get("/api/telemetry", params={"owner": owner}).json()
    assert [n["node_id"] for n in t["nodes"]] == ["OWN-01"] and t["nodes"][0]["floor"] == 3
    site = {n["node_id"] for n in api.get("/api/telemetry", params={"owner": "site"}).json()["nodes"]}
    assert "OWN-01" not in site and "ESP32-01" in site  # the site's own (demo) nodes
    assert len(api.get("/api/telemetry").json()["nodes"]) == len(site) + 1  # no filter: everything

    api.post("/api/auth/logout")
    api.login(VIEWER)
    assert api.get("/api/telemetry", params={"owner": owner}).json()["nodes"] == []  # viewers can't peek
