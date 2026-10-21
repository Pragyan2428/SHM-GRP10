"""Floors come from what the nodes send, so the building view fits whatever building is monitored."""
import pytest

from app.services.floors import floor_from_location, normalise_floor

from .conftest import ADMIN, ingest


@pytest.mark.parametrize("location, floor", [
    ("Ground floor - column C3, mid-height", 0),
    ("GF lobby column", 0),
    ("Foundation - column C1 footing, north-west corner", 0),
    ("First floor - main beam B2, mid-span", 1),  # "B2" is a beam, not basement 2
    ("Second floor - slab S4 centre, assembly hall", 2),
    ("Third floor - beam-column joint C4/B7, east face", 3),
    ("12th floor corridor", 12),
    ("2nd storey slab", 2),
    ("Floor 7 east wing", 7),
    ("Level 4 car park", 4),
    ("3F north column", 3),
    ("Basement column", -1),
    ("Basement 2 retaining wall", -2),
    ("Roof - water tank support frame", "roof"),
    ("Terrace parapet", "roof"),
    ("Main bridge girder", None),
    ("", None),
    (None, None),
])
def test_floor_from_location(location, floor):
    assert floor_from_location(location) == floor


@pytest.mark.parametrize("value, floor", [
    (3, 3), (0, 0), (-1, -1), ("5", 5), ("roof", "roof"), ("ROOF", "roof"), ("2nd floor", 2),
    (500, None), ("", None), (None, None), (True, None),
])
def test_normalise_floor(value, floor):
    assert normalise_floor(value) == floor


def test_nodes_report_their_floor(api):
    api.login(ADMIN)
    ingest(api, {"node_id": "REAL-01", "location": "4th floor - column C2", "readings": {"strain": 100}})
    ingest(api, {"node_id": "REAL-02", "location": "Plant room", "floor": "roof", "readings": {"strain": 100}})
    ingest(api, {"node_id": "REAL-03", "location": "Pump house", "readings": {"strain": 100}})
    ingest(api, {"node_id": "REAL-04", "location": "Ground floor", "floor": 6, "readings": {"strain": 100}})  # sent floor wins
    floors = {n["node_id"]: n["floor"] for n in api.get("/api/telemetry").json()["nodes"]}
    assert floors["REAL-01"] == 4 and floors["REAL-02"] == "roof" and floors["REAL-03"] is None and floors["REAL-04"] == 6
    nodes = {n["node_id"]: n for n in api.get("/api/nodes").json()["items"]}
    assert nodes["REAL-01"]["floor"] == 4 and nodes["ESP32-06"]["floor"] == "roof"  # demo nodes get floors from their text


def test_an_unreadable_floor_is_ignored_not_rejected(api):
    r = ingest(api, {"node_id": "REAL-09", "location": "Lab", "floor": "attic-ish", "readings": {"strain": 100}})
    assert r.status_code == 200
    api.login(ADMIN)
    node = next(n for n in api.get("/api/nodes").json()["items"] if n["node_id"] == "REAL-09")
    assert node["floor"] is None
