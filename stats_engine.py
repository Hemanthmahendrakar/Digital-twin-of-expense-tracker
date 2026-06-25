"""
stats_engine.py

Pure rule logic that turns Expense Tracker analytics into 4 avatar stats
(health, energy, happiness, wealth_level), each on a 0-100 scale, plus a
mapping from stats -> animation state ("idle" | "happy" | "tired" | "sad").

Kept free of Flask / requests / sqlite so it can be unit tested by just
passing in plain dicts and lists.

ASSUMPTIONS (documented per the brief, tune freely):
  - FOOD_SPEND_RATIO_THRESHOLD: if Food spend is more than this fraction of
    current_month_total, health takes a hit. Any nonzero "Health" category
    spend gives a small health boost (proxy for e.g. gym/medical/wellness).
  - ENERGY: simplified per the brief to a comparison between current month
    total and the historical average month total (from by_month). Spending
    meaningfully *above* the historical average month drains energy;
    spending below it (within reason) restores it.
  - HAPPINESS: small, healthy amounts of Entertainment/Travel spend are a
    net positive (life isn't just about saving). Zero spend in either
    category for 30+ days is a slight negative (no fun). Excessive spend
    relative to total is a negative (overspending stress).
  - WEALTH_LEVEL: drifts up over time (a few points per recalculation) when
    current_month_total stays under MONTHLY_BUDGET_THRESHOLD, and drifts
    down when over it. This is the one stat that's explicitly stateful
    (depends on the previous value), the other three are recomputed fresh
    each time from the latest snapshot.
  - All stats are clamped to [0, 100]. Missing/zero-count data degrades
    gracefully to neutral (50) starting points rather than crashing.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Configurable constants — adjust these to retune the "personality" of the
# rules without touching any logic below.
# ---------------------------------------------------------------------------

FOOD_SPEND_RATIO_THRESHOLD = 0.40     # Food > 40% of month total hurts health
HEALTH_CATEGORY_BOOST = 8             # any Health-category spend -> +8 health
HEALTH_FOOD_PENALTY = 15              # penalty applied when over threshold

ENERGY_OVERSPEND_PENALTY = 20         # current month > avg historical month
ENERGY_UNDERSPEND_BONUS = 12          # current month comfortably under avg

ENTERTAINMENT_TRAVEL_CATEGORIES = ("Entertainment", "Travel")
FUN_SPEND_MIN_RATIO = 0.02            # >2% of month total on fun -> healthy
FUN_SPEND_MAX_RATIO = 0.25            # >25% of month total on fun -> excess
FUN_SPEND_HEALTHY_BONUS = 10
FUN_SPEND_EXCESS_PENALTY = 12
NO_FUN_DAYS_THRESHOLD = 30
NO_FUN_PENALTY = 6

MONTHLY_BUDGET_THRESHOLD = 2000.0     # assumed monthly budget, in currency units
WEALTH_DRIFT_UP = 4
WEALTH_DRIFT_DOWN = 6

DEFAULT_STAT = 50  # neutral starting point when there's no data to go on

# Animation-state thresholds, checked in order. First match wins.
# Each entry: (predicate over stats dict) -> animation name
def map_animation_state(stats: dict) -> str:
    health = stats.get("health", DEFAULT_STAT)
    energy = stats.get("energy", DEFAULT_STAT)
    happiness = stats.get("happiness", DEFAULT_STAT)
    wealth_level = stats.get("wealth_level", DEFAULT_STAT)

    avg = (health + energy + happiness + wealth_level) / 4

    if happiness >= 65 and avg >= 60:
        return "happy"
    if health <= 35 or happiness <= 30:
        return "sad"
    if energy <= 35:
        return "tired"
    return "idle"


def _clamp(value: float) -> float:
    return max(0.0, min(100.0, value))


def compute_health(summary: dict, by_category: list[dict]) -> float:
    current_month_total = summary.get("current_month_total") or 0.0
    health = float(DEFAULT_STAT)

    if current_month_total > 0:
        food_total = next(
            (c.get("total", 0) for c in by_category if c.get("category") == "Food"),
            0,
        )
        if (food_total / current_month_total) > FOOD_SPEND_RATIO_THRESHOLD:
            health -= HEALTH_FOOD_PENALTY

    health_category_total = next(
        (c.get("total", 0) for c in by_category if c.get("category") == "Health"),
        0,
    )
    if health_category_total > 0:
        health += HEALTH_CATEGORY_BOOST

    return _clamp(health)


def compute_energy(summary: dict, by_month: list[dict]) -> float:
    current_month_total = summary.get("current_month_total") or 0.0
    energy = float(DEFAULT_STAT)

    historical_months = [m.get("total", 0) for m in by_month if m.get("total") is not None]
    if historical_months:
        avg_month = sum(historical_months) / len(historical_months)
        if avg_month > 0:
            if current_month_total > avg_month:
                energy -= ENERGY_OVERSPEND_PENALTY
            elif current_month_total < avg_month * 0.8:
                energy += ENERGY_UNDERSPEND_BONUS

    return _clamp(energy)


def compute_happiness(
    summary: dict,
    by_category: list[dict],
    days_since_last_fun_spend: float | None = None,
) -> float:
    current_month_total = summary.get("current_month_total") or 0.0
    happiness = float(DEFAULT_STAT)

    fun_total = sum(
        c.get("total", 0) for c in by_category
        if c.get("category") in ENTERTAINMENT_TRAVEL_CATEGORIES
    )

    if current_month_total > 0:
        fun_ratio = fun_total / current_month_total
        if fun_ratio > FUN_SPEND_MAX_RATIO:
            happiness -= FUN_SPEND_EXCESS_PENALTY
        elif fun_ratio >= FUN_SPEND_MIN_RATIO:
            happiness += FUN_SPEND_HEALTHY_BONUS

    if fun_total == 0 and days_since_last_fun_spend is not None:
        if days_since_last_fun_spend >= NO_FUN_DAYS_THRESHOLD:
            happiness -= NO_FUN_PENALTY

    return _clamp(happiness)


def compute_wealth_level(summary: dict, previous_wealth_level: float | None) -> float:
    current_month_total = summary.get("current_month_total") or 0.0
    wealth_level = float(previous_wealth_level) if previous_wealth_level is not None else float(DEFAULT_STAT)

    if current_month_total <= MONTHLY_BUDGET_THRESHOLD:
        wealth_level += WEALTH_DRIFT_UP
    else:
        wealth_level -= WEALTH_DRIFT_DOWN

    return _clamp(wealth_level)


def compute_all_stats(
    summary: dict,
    by_category: list[dict],
    by_month: list[dict],
    previous_stats: dict | None = None,
    days_since_last_fun_spend: float | None = None,
) -> dict:
    """Compute the full stat block from the latest Expense Tracker snapshot.

    previous_stats: the most recent row from avatar_stats (or None on first
    run), used only for wealth_level's drift logic.
    """
    previous_wealth_level = (previous_stats or {}).get("wealth_level")

    stats = {
        "health": compute_health(summary, by_category),
        "energy": compute_energy(summary, by_month),
        "happiness": compute_happiness(summary, by_category, days_since_last_fun_spend),
        "wealth_level": compute_wealth_level(summary, previous_wealth_level),
    }
    stats["animation_state"] = map_animation_state(stats)
    return stats
