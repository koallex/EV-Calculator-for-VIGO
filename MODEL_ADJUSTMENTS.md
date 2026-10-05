# Consumption model adjustment — 2026-08-26

The route-consumption model was corrected after reviewing the long-distance calculation.

## Main issue
The previous quadratic speed formula did not match its own calibration comments. It produced approximately 18.6 kWh/100 km at 90 km/h and 20.6 kWh/100 km at 110 km/h, while the intended anchors were 15.4 and 18.2. This inflated 200–300 km motorway trips before weather, wind, terrain and HVAC were added.

## Changes
- Replaced the inconsistent quadratic with a piecewise speed curve: 15.0 @ 90 km/h, 16.0 @ 100, 17.2 @ 110, 18.6 @ 120, 20.2 @ 130.
- Historical trip consumption is no longer used 1:1 as a driving-style multiplier. It now contributes only 35% of the deviation and is capped to ±8%, because historical consumption already contains weather, terrain and HVAC effects.
- Route elevation energy now uses 1600 kg instead of 1850 kg, consistent with the current Vigo curb-weight reference (~1526 kg) plus a modest driver/luggage allowance.
- Elevation noise threshold increased from 2 m to 3 m to reduce accumulation of small API/profile fluctuations on long routes.
- HVAC remains time-based: kW × trip hours.

## Important
Distance itself is not penalized. A 300 km route at the same speed and conditions should have approximately the same kWh/100 km as a 100 km route; only total kWh scales with distance. Long routes can still consume more per 100 km when their route-specific weather, wind, rain/snow, elevation, speed or temperature justify it.


## High-speed aerodynamic calibration (2026-08-28)

- The common speed model is now continuous and uses a quadratic high-speed branch above ~80 km/h, reflecting that aerodynamic energy per distance scales approximately with airspeed².
- The branch is calibrated against the owner's observed 77.7 km highway run (~105 km/h average, +25…29°C, HVAC OFF, calm wind, dashboard 21.4 kWh/100 km).
- No factory Cd value is assumed because a verified Cd for this Vigo configuration is not available in the project data.
- HUD, calculator and segmented route calculations all consume the same `interpolateVigoSpeedConsumption()` function.
- The trip journal currently contains useful driving-style factors but no high-speed average-speed trips, so it is not used to invent a high-speed correction. New highway logs can be used for later empirical recalibration.

## Geely EX2 calibration — 2026-10-05

Real trip: Minsk (Sharangoicha 52–57 / Dneprovskaya) → Lyadishche (Borisov), 95 km.
- Vehicle: Geely EX2 (39.4 kWh), 4 passengers
- Start SoC 80% → actual arrival 55% (used 25%)
- Calculator previously predicted 50% arrival (used 30%)
- Conditions: clear, 18–20 °C, light wind, max 95 km/h, avg ~70 km/h

Adjustment (EX2 profile only):
- consumptionScale 39.4 kWh: 0.93 → 0.78
- 35 kWh: 0.92 → 0.77
- 47.1 kWh: 0.94 → 0.79

This lowers predicted road-load energy so the same trip now lands near the observed 55% remaining. Other vehicles and the shared Vigo speed curve are unchanged.
