"""Trend-based anomaly scoring (0-100) used for early warnings before a hard threshold.

Signals combined per sensor (node + parameter):
  * distance from the configured safe threshold
  * rolling average / rolling standard deviation over the last WINDOW readings
  * slope of the most recent readings (least squares) and projected readings-to-limit
  * consecutive upward moves
  * deviation from a sensor-specific baseline (EMA learned only from nominal readings)
  * correlation: several parameters on the same node abnormal at once (applied in processing)
"""
from __future__ import annotations

import math
from statistics import fmean, pstdev
from typing import Optional

WINDOW = 20
SLOPE_POINTS = 8
CORRELATION_BONUS = 10
ABNORMAL_SCORE = 40


def level_for(score: float) -> str:
    if score >= 90:
        return "critical"
    if score >= 70:
        return "warning"
    if score >= 40:
        return "watch"
    return "normal"


def _slope(values: list[float]) -> float:
    n = len(values)
    if n < 3:
        return 0.0
    xs = range(n)
    mx, my = (n - 1) / 2, fmean(values)
    den = sum((x - mx) ** 2 for x in xs)
    return sum((x - mx) * (y - my) for x, y in zip(xs, values)) / den if den else 0.0


def _fmt(v: float, decimals: int) -> str:
    return f"{v:.{decimals}f}"


def compute(state: Optional[dict], value: float, th: dict) -> dict:
    """Pure function: previous state + new value -> new state (including score & reasons)."""
    state = dict(state or {})
    label = th.get("label", th["parameter"]).split(" /")[0]
    unit = th["unit"]
    dec = th.get("decimals", 2)
    safe = float(th["safe_threshold"]) or 1.0

    recent = list(state.get("recent") or [])[-(WINDOW - 1):] + [float(value)]
    n = len(recent)
    rolling_avg = fmean(recent)
    rolling_std = pstdev(recent) if n > 1 else 0.0
    slope = _slope(recent[-SLOPE_POINTS:])
    slope_pct = slope / safe * 100
    ratio = value / safe

    rises = 0
    for i in range(n - 1, 0, -1):
        if recent[i] > recent[i - 1]:
            rises += 1
        else:
            break

    avg_increasing = False
    if n >= 10:
        a_now, a_prev = fmean(recent[-5:]), fmean(recent[-10:-5])
        avg_increasing = a_now - a_prev > 0.04 * safe
        if n >= 15:
            avg_increasing = avg_increasing and a_prev >= fmean(recent[-15:-10])

    # Sensor-specific baseline: EMA of mean/variance, learned while the sensor is nominal.
    b_mean = state.get("baseline_mean")
    b_var = state.get("baseline_var", 0.0)
    b_n = state.get("baseline_n", 0)
    z = 0.0
    if b_mean is not None and b_n >= 5:
        z = (value - b_mean) / max(math.sqrt(b_var), 0.02 * safe)
    if value < th["warning_threshold"]:
        # Robust baseline: learn quickly from typical readings, barely at all from outliers,
        # so a slow drift doesn't drag the baseline along with it.
        alpha = max(1.0 / (b_n + 1), 0.02) if (b_n < 5 or abs(z) < 2.5) else 0.005
        if b_mean is None:
            b_mean, b_var = float(value), 0.0
        else:
            diff = value - b_mean
            b_mean += alpha * diff
            b_var = (1 - alpha) * (b_var + alpha * diff * diff)
        b_n += 1

    eta = (safe - value) / slope if slope > 0 and value < safe else None

    # ---- score ---------------------------------------------------------------
    if ratio >= 1:
        score = 90 + min(10.0, (ratio - 1) * 40)
    else:
        prox = max(0.0, (ratio - 0.5) / 0.5 * 55) if ratio >= 0.5 else 0.0
        trend = min(20.0, (rises - 2) * 3.5) if rises >= 3 else 0.0
        if eta is not None and eta <= 12:
            trend += (12 - eta) / 12 * 15
        dev = min(20.0, (abs(z) - 2) * 8) if abs(z) > 2 else 0.0
        score = min(89.0, prox + min(trend, 30.0) + dev)

    # ---- reasons / early-warning triggers -------------------------------------
    pct = round(ratio * 100)
    reasons: list[str] = []
    if ratio < 1:
        if rises >= 5 and ratio >= 0.6:
            reasons.append(f"{label} has increased for {rises} consecutive readings and is now at "
                           f"{pct}% of the safe limit.")
        if avg_increasing:
            reasons.append(f"Rolling average is rising steadily ({_fmt(fmean(recent[-10:-5]), dec)} → "
                           f"{_fmt(fmean(recent[-5:]), dec)} {unit}).")
        if abs(z) >= 3:
            reasons.append(f"Value deviates {abs(z):.1f}σ from the sensor baseline "
                           f"({_fmt(b_mean or 0, dec)} {unit}).")
        if eta is not None and eta <= 6:
            reasons.append(f"At the current rate the safe limit is reached in about {max(1, round(eta))} readings.")
    else:
        reasons.append(f"{label} is at {pct}% of the safe limit ({_fmt(value, dec)} {unit} ≥ "
                       f"{_fmt(safe, dec)} {unit}).")

    signals = sum([rises >= 5, avg_increasing, abs(z) >= 3, eta is not None and eta <= 12, ratio >= 0.7])
    confidence = min(99, round(100 * min(1.0, n / WINDOW) * (0.4 + 0.15 * signals)))
    trend_dir = "rising" if slope_pct > 0.5 else "falling" if slope_pct < -0.5 else "stable"

    state.update({
        "recent": recent,
        "baseline_mean": b_mean, "baseline_var": b_var, "baseline_n": b_n,
        "value": float(value),
        "rolling_avg": round(rolling_avg, 4), "rolling_std": round(rolling_std, 4),
        "slope": round(slope, 5), "trend": trend_dir, "consecutive_rises": rises,
        "ratio": round(ratio, 4), "z_score": round(z, 2),
        "score": round(score, 1), "level": level_for(score), "confidence": confidence,
        "reasons": reasons,
        "reason": reasons[0] if reasons else "Readings are within the normal operating envelope.",
        "early_warning": ratio < 1 and score >= 70 and bool(reasons),
    })
    return state


def apply_correlation(states: dict[str, dict]) -> None:
    """Boost scores when several parameters on one node are abnormal together."""
    abnormal = [p for p, s in states.items() if s["score"] >= ABNORMAL_SCORE]
    if len(abnormal) < 2:
        return
    names = ", ".join(abnormal)
    for p in abnormal:
        s = states[p]
        cap = 100.0 if s["ratio"] >= 1 else 89.0
        s["score"] = round(min(cap, s["score"] + CORRELATION_BONUS), 1)
        s["level"] = level_for(s["score"])
        msg = f"Multiple related parameters are abnormal together on this node ({names})."
        s["reasons"] = s["reasons"] + [msg]
        if s["ratio"] < 1 and s["score"] >= 70:
            s["early_warning"] = True
        if s["reason"].startswith("Readings are within"):
            s["reason"] = msg
