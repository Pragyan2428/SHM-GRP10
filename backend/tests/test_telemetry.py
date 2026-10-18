from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.db import get_db
from app.main import create_app
from app.services import anomaly
from app.services.thresholds import default_doc

from .conftest import ADMIN, Api, ingest, payload

# Anomaly sequences below were designed on an 8-unit safe limit; scaling them to the
# temperature limit (42 °C) keeps every ratio and z-score identical.
SCALE = 42.0 / 8.0


# ---- simulated telemetry ------------------------------------------------------
def test_simulated_telemetry_is_stored_and_served(admin):
    sim = admin.app.state.simulator
    for _ in range(3):
        admin.run(sim.tick)
    t = admin.get("/api/telemetry").json()
    assert t["connection"] == "healthy"
    assert t["active_nodes"] == 6 and t["total_nodes"] == 6
    assert [p["parameter"] for p in t["parameters"]] == ["strain", "vibration", "temperature"]
    strain = t["parameters"][0]
    assert strain["unit"] == "με" and strain["safe_threshold"] == 620
    cur = strain["current"]
    for key in ("value", "status", "anomaly_score", "timestamp", "location", "node_id"):
        assert key in cur
    assert len(strain["series"]) == 3
    hist = admin.get("/api/telemetry/history", params={"page_size": 5}).json()
    assert hist["total"] == 3 * 6 * 3
    row = hist["items"][0]
    for key in ("parameter", "value", "unit", "safe_threshold", "node_id", "location", "timestamp",
                "status", "anomaly_score", "source"):
        assert key in row
    assert row["source"] == "simulated" and "_id" not in row


def test_simulator_values_are_realistic(admin):
    sim = admin.app.state.simulator
    sim.rng.seed(7)
    prev = None
    for _ in range(30):
        res = admin.run(sim.tick)
        strain = next(r["value"] for r in res[0]["readings"] if r["parameter"] == "strain")
        if prev is not None and sim.sensors["ESP32-01"]["strain"].episode is None:
            assert abs(strain - prev) < 0.12 * 620  # no wild jumps
        prev = strain


def test_simulator_toggle(admin):
    assert admin.post("/api/system/simulator", json={"enabled": False}).json()["enabled"] is False
    assert admin.get("/api/telemetry").json()["simulator_enabled"] is False
    admin.post("/api/system/simulator", json={"enabled": True})
    assert admin.get("/api/system/status").json()["simulator"]["enabled"] is True


# ---- HTTP ingestion -----------------------------------------------------------
def test_http_ingest_requires_device_key(api):
    assert ingest(api, payload(), key=None).status_code == 401
    assert ingest(api, payload(), key="wrong").status_code == 401


def test_http_ingest_validates_payload(api):
    bad = payload()
    bad["readings"]["pressure"] = 1
    r = ingest(api, bad)
    assert r.status_code == 422 and "unknown parameter" in r.json()["detail"]
    r = ingest(api, payload(strain=float("1e9")))
    assert r.status_code == 422
    future = payload()
    future["timestamp"] = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    assert ingest(api, future).status_code == 422
    assert ingest(api, {"node_id": "bad id!", "readings": {"strain": 1}}).status_code == 422


def test_only_the_three_project_sensors_are_accepted(admin):
    for extra in ("impact", "displacement"):
        bad = payload()
        bad["readings"][extra] = 1.0
        r = ingest(admin, bad)
        assert r.status_code == 422 and "strain, vibration, temperature" in r.json()["detail"]
    params = admin.get("/api/telemetry").json()["parameters"]
    assert {p["parameter"]: p["sensor"] for p in params} == {
        "strain": "HX711 strain gauge", "vibration": "ADXL345 accelerometer", "temperature": "DS18B20 temperature sensor"}


def test_http_ingest_processes_and_updates_node(admin):
    body = payload(node="esp32-09")
    body["timestamp"] = (datetime.now(timezone.utc) - timedelta(seconds=2)).isoformat()
    r = ingest(admin, body)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["ok"] and out["node_id"] == "ESP32-09" and out["alert_triggered"] is False
    assert {x["parameter"] for x in out["readings"]} == {"strain", "vibration", "temperature"}
    assert all(x["source"] == "http" and x["status"] == "nominal" for x in out["readings"])
    node = admin.get("/api/nodes/ESP32-09").json()["node"]
    assert node["online"] and node["battery"] == 94 and node["rssi"] == -48 and node["data_source"] == "http"
    # Device retry with the same timestamp is idempotent
    again = ingest(admin, body).json()
    assert again["duplicate"] is True
    assert admin.get("/api/telemetry/history", params={"node_id": "ESP32-09"}).json()["total"] == 3


def test_device_auth_not_configured(settings):
    from .conftest import make_settings
    app = create_app(make_settings(DEVICE_SHARED_KEY="", DEVICE_KEYS=""), start_background=False)
    with TestClient(app) as c:
        r = c.post("/api/ingest", json=payload(), headers={"X-Device-Key": "x"})
        assert r.status_code == 503 and "not configured" in r.json()["detail"]


def test_per_device_keys():
    from .conftest import make_settings
    app = create_app(make_settings(DEVICE_SHARED_KEY="", DEVICE_KEYS="ESP32-01:k1,ESP32-02:k2"),
                     start_background=False)
    with TestClient(app) as c:
        assert c.post("/api/ingest", json=payload("ESP32-01"), headers={"X-Device-Key": "k1"}).status_code == 200
        assert c.post("/api/ingest", json=payload("ESP32-01"), headers={"X-Device-Key": "k2"}).status_code == 401


# ---- threshold events -----------------------------------------------------------
def test_threshold_breach_creates_single_alert(admin):
    ingest(admin, payload())
    r = ingest(admin, payload(vibration=2.05)).json()
    assert r["alert_triggered"] is True
    alert = next(a for a in r["alerts"] if a["type"] == "threshold")
    for key in ("id", "parameter", "value", "unit", "threshold", "node_id", "location", "severity", "created_at",
                "status", "acknowledged_by", "acknowledged_at", "notification_status"):
        assert key in alert
    assert alert["parameter"] == "vibration" and alert["threshold"] == 1.8
    assert alert["severity"] == "major" and alert["location"] == "North wing - column C1"
    # Same excursion continues: no duplicate alert, occurrences counted, escalates to critical
    for v in (2.1, 2.4):
        assert ingest(admin, payload(vibration=v)).json()["alerts"] == []
    events = admin.get("/api/events", params={"type": "threshold"}).json()
    assert events["total"] == 1
    ev = events["items"][0]
    assert ev["occurrences"] == 3 and ev["peak_value"] == 2.4 and ev["severity"] == "critical"
    # Recovery then a new breach within cooldown -> still no duplicate
    ingest(admin, payload(vibration=0.9))
    ingest(admin, payload(vibration=2.0))
    assert admin.get("/api/events", params={"type": "threshold"}).json()["total"] == 1


def test_new_alert_after_cooldown(admin):
    admin.put("/api/thresholds", json={"thresholds": [{"parameter": "strain", "cooldown_seconds": 0}]})
    ingest(admin, payload(strain=700))
    ingest(admin, payload(strain=300))
    ingest(admin, payload(strain=710))
    assert admin.get("/api/events", params={"parameter": "strain", "type": "threshold"}).json()["total"] == 2


def test_debounce_delays_alert(admin):
    admin.put("/api/thresholds", json={"thresholds": [{"parameter": "vibration", "debounce_seconds": 10}]})
    t0 = datetime.now(timezone.utc) - timedelta(seconds=60)
    b = payload(vibration=2.0)
    b["timestamp"] = t0.isoformat()
    assert ingest(admin, b).json()["alerts"] == []
    b["timestamp"] = (t0 + timedelta(seconds=11)).isoformat()
    assert ingest(admin, b).json()["alert_triggered"] is True


def test_disabled_parameter_does_not_alert(admin):
    admin.put("/api/thresholds", json={"thresholds": [{"parameter": "temperature", "enabled": False}]})
    assert ingest(admin, payload(temperature=55)).json()["alert_triggered"] is False


def test_threshold_settings_validation_and_audit(admin):
    r = admin.put("/api/thresholds", json={"thresholds": [{"parameter": "strain", "safe_threshold": 400}]})
    assert r.status_code == 422  # warning (496) must stay below safe
    r = admin.put("/api/thresholds", json={"thresholds": [
        {"parameter": "strain", "safe_threshold": 650, "warning_threshold": 520, "critical_threshold": 800}]})
    assert r.status_code == 200
    strain = next(t for t in r.json()["items"] if t["parameter"] == "strain")
    assert strain["safe_threshold"] == 650 and strain["updated_by"] == ADMIN["email"]
    audit = admin.get("/api/thresholds/audit").json()["items"][0]
    assert audit["actor_email"] == ADMIN["email"] and audit["details"]["safe_threshold"] == {"from": 620, "to": 650}
    # New readings use the new threshold
    assert ingest(admin, payload(strain=630)).json()["alert_triggered"] is False


# ---- acknowledgement ------------------------------------------------------------
def test_acknowledge_alert(admin):
    alert = next(a for a in ingest(admin, payload(temperature=45)).json()["alerts"] if a["type"] == "threshold")
    r = admin.post(f"/api/events/{alert['id']}/acknowledge", json={"note": "Inspected - plant room heat"})
    assert r.status_code == 200
    ev = r.json()
    assert ev["status"] == "acknowledged" and ev["acknowledged_by"] == ADMIN["email"] and ev["acknowledged_at"]
    assert admin.post(f"/api/events/{alert['id']}/acknowledge", json={}).status_code == 409
    assert admin.post("/api/events/ALT-NOPE/acknowledge", json={}).status_code == 404
    assert admin.get("/api/events", params={"status": "acknowledged"}).json()["total"] == 1
    assert admin.get("/api/telemetry").json()["open_alerts"] == 0


def test_event_filters_and_pagination(admin):
    admin.put("/api/thresholds", json={"thresholds": [
        {"parameter": p, "cooldown_seconds": 0} for p in ("strain", "temperature")]})
    for i in range(6):
        ingest(admin, payload(node=f"ESP32-0{i % 2 + 1}", strain=700 if i % 2 else 300, temperature=45 if i % 2 == 0 else 27))
        ingest(admin, payload(node=f"ESP32-0{i % 2 + 1}"))
    all_ev = admin.get("/api/events", params={"type": "threshold", "page_size": 2}).json()
    assert all_ev["total"] == 6 and len(all_ev["items"]) == 2 and all_ev["pages"] == 3
    assert admin.get("/api/events", params={"parameter": "temperature"}).json()["total"] == 3
    assert admin.get("/api/events", params={"node_id": "esp32-02"}).json()["total"] == 3
    assert admin.get("/api/events", params={"q": "north"}).json()["total"] == 6
    newest = admin.get("/api/events", params={"sort": "newest"}).json()["items"][0]["created_at"]
    oldest = admin.get("/api/events", params={"sort": "oldest"}).json()["items"][0]["created_at"]
    assert newest >= oldest
    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    assert admin.get("/api/events", params={"date_from": future}).json()["total"] == 0


# ---- nodes ----------------------------------------------------------------------
def test_sensor_node_online_offline(admin):
    admin.run(admin.app.state.simulator.tick)
    nodes = admin.get("/api/nodes").json()["items"]
    assert len(nodes) == 6 and all(n["online"] for n in nodes)
    n = nodes[0]
    for key in ("node_id", "location", "status", "last_seen", "battery", "rssi", "firmware", "data_source",
                "calibration_status", "latest", "error"):
        assert key in n

    async def age():
        await get_db().sensor_nodes.update_one(
            {"node_id": "ESP32-03"}, {"$set": {"last_seen": datetime.now(timezone.utc) - timedelta(minutes=5)}})
    admin.run(age)
    n3 = admin.get("/api/nodes/ESP32-03").json()
    assert n3["node"]["status"] == "offline"
    assert len(n3["series"]["strain"]) == 1
    assert admin.get("/api/nodes/ESP32-99").status_code == 404


# ---- MQTT -----------------------------------------------------------------------
def test_mqtt_disabled_gracefully_and_handler_works(admin):
    st = admin.get("/api/system/status").json()["mqtt"]
    assert st["configured"] is False and "not configured" in st["message"]
    r = admin.post("/api/mqtt/test", json={})
    assert r.json()["ok"] is False
    r = admin.post("/api/mqtt/test", json={"topic": "shm/ESP32-07/telemetry",
                                           "payload": {"location": "Deck east", "readings": {"strain": 650}}})
    assert r.status_code == 200, r.text
    assert r.json()["processed"]["readings"][0]["source"] == "mqtt"
    bad = admin.post("/api/mqtt/test", json={"topic": "shm/ESP32-07/telemetry",
                                             "payload": {"node_id": "ESP32-08", "readings": {"strain": 1}}})
    assert bad.status_code == 422


# ---- anomaly scoring ------------------------------------------------------------
def test_anomaly_score_bands():
    assert anomaly.level_for(10) == "normal"
    assert anomaly.level_for(40) == "watch"
    assert anomaly.level_for(75) == "warning"
    assert anomaly.level_for(95) == "critical"


def test_anomaly_normal_readings_score_low():
    th = default_doc("temperature")
    state = None
    for v in [3.6, 3.5, 3.7, 3.6, 3.5, 3.6, 3.7, 3.6, 3.5, 3.6, 3.6, 3.5]:
        state = anomaly.compute(state, v * SCALE, th)
    assert state["score"] < 40 and state["level"] == "normal" and not state["early_warning"]
    assert state["trend"] == "stable"


def test_anomaly_rising_trend_triggers_early_warning():
    th = default_doc("temperature")
    state = None
    for v in [3.6, 3.5, 3.7, 3.6, 3.5, 3.6, 3.7, 3.6, 3.7, 3.6]:
        state = anomaly.compute(state, v * SCALE, th)
    for v in [4.0, 4.4, 4.8, 5.1, 5.4, 5.7, 5.9, 6.1]:
        state = anomaly.compute(state, v * SCALE, th)
    assert state["value"] < th["safe_threshold"]
    assert state["score"] >= 70 and state["level"] == "warning" and state["early_warning"]
    assert state["trend"] == "rising" and state["consecutive_rises"] == 8
    assert "increased for 8 consecutive readings" in state["reason"]
    assert "76% of the safe limit" in state["reason"]
    assert 0 < state["confidence"] <= 99 and state["rolling_avg"] > 3.6 * SCALE


def test_anomaly_breach_scores_critical():
    th = default_doc("strain")
    state = anomaly.compute(None, 300, th)
    state = anomaly.compute(state, 700, th)
    assert state["score"] >= 90 and state["level"] == "critical" and not state["early_warning"]


def test_anomaly_correlation_bonus():
    states = {"strain": {"score": 50, "ratio": 0.8, "level": "watch", "reasons": [], "reason": "x", "early_warning": False},
              "vibration": {"score": 65, "ratio": 0.85, "level": "watch", "reasons": [], "reason": "y",
                               "early_warning": False},
              "temperature": {"score": 5, "ratio": 0.6, "level": "normal", "reasons": [], "reason": "z",
                              "early_warning": False}}
    anomaly.apply_correlation(states)
    assert states["strain"]["score"] == 60 and states["vibration"]["score"] == 75
    assert states["vibration"]["early_warning"] and states["temperature"]["score"] == 5
    assert "Multiple related parameters" in states["vibration"]["reasons"][-1]


def test_early_warning_event_is_distinct(admin):
    for v in [3.6, 3.5, 3.7, 3.6, 3.5, 3.6, 3.7, 3.6, 3.5, 3.6, 4.0, 4.4, 4.8, 5.1, 5.4, 5.7, 5.9, 6.1, 6.3]:
        ingest(admin, payload(temperature=round(v * SCALE, 2)))
    ews = admin.get("/api/events", params={"type": "early_warning"}).json()
    assert ews["total"] == 1
    ew = ews["items"][0]
    assert ew["severity"] == "early_warning" and ew["reason"] and ew["confidence"] > 0
    assert admin.get("/api/events", params={"type": "threshold"}).json()["total"] == 0
    summary = admin.get("/api/anomaly-summary").json()
    assert summary["overall_score"] >= 70 and summary["active_early_warnings"]


# ---- persistence ----------------------------------------------------------------
def test_data_persists_across_restart(settings):
    app = create_app(settings, start_background=False)
    with TestClient(app) as c:
        api = Api(c)
        api.login(ADMIN)
        ingest(api, payload(strain=700))
        api.put("/api/thresholds", json={"thresholds": [{"parameter": "vibration", "safe_threshold": 1.9}]})
        api.drain()
    app2 = create_app(settings, start_background=False)
    with TestClient(app2) as c:
        api = Api(c)
        api.login(ADMIN)
        assert api.get("/api/events").json()["total"] == 1
        assert api.get("/api/telemetry/history").json()["total"] == 3
        vibration = next(t for t in api.get("/api/thresholds").json()["items"] if t["parameter"] == "vibration")
        assert vibration["safe_threshold"] == 1.9
        assert api.get("/api/users").json()["items"][0]["email"] == ADMIN["email"]
