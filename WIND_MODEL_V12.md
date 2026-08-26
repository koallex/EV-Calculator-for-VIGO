# Wind model v12

The previous wind model multiplied the entire base consumption by a percentage derived from `(vehicle speed + headwind) / vehicle speed`. Because the percentage penalty shrank as vehicle speed increased, a strong headwind could paradoxically make a higher road speed consume less total energy than a lower speed.

v12 models wind through relative air speed:

- longitudinal wind component = wind speed × cos(relative angle)
- lateral wind component = wind speed × sin(relative angle)
- relative air speed = sqrt((vehicle speed + longitudinal wind)^2 + lateral wind^2)
- aerodynamic drag/energy scales with relative air speed²
- only the aerodynamic share of the base consumption is adjusted; rolling/electrical loads are not multiplied by wind
- aerodynamic share varies smoothly with road speed (30–60%) to avoid artificial jumps

This means a headwind always increases aerodynamic energy, a tailwind reduces it, and a crosswind adds aerodynamic drag according to the resultant airspeed. For normal conditions the total kWh/100 km curve remains increasing with vehicle speed.
