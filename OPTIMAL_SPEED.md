# Optimal route speed

The route planner now shows an "Optimal speed" card after a route forecast is calculated.

- It evaluates 50, 55, ... 120 km/h.
- It minimizes **total route energy (kWh)**, not just kWh/100 km.
- It uses the currently loaded route distance/elevation, weather, wind, precipitation, driver calibration and time-based HVAC model.
- HVAC therefore makes very low speeds less attractive because the climate system runs longer.
- The calculation is local and does not make additional route, weather or elevation API requests.
- It is an advisory model, not a recommendation to exceed local speed limits.
