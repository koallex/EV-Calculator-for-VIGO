# HVAC v14 — Heat Pump + Supplemental PTC

The route model keeps HVAC as electrical power (kW), with route energy = average HVAC power × trip hours.

Cold-weather planning curve (estimate, not vehicle telemetry):
- +10°C: ~0.82 kW
- +5°C: ~1.06 kW
- 0°C: ~1.30 kW
- -5°C: ~1.60 kW
- -10°C: ~1.90 kW
- -15°C: ~2.30 kW
- -20°C: ~2.70 kW
- -25°C: ~3.25 kW
- -30°C: ~3.80 kW (cap)

The curve represents a heat pump carrying most of the steady cabin load, with supplemental PTC heating at low temperatures. For long trips the average HVAC power is reduced modestly (down to a 92% floor) to represent the fact that the initial warm-up/PTC contribution is less important after the cabin is stabilized.

The battery cold-efficiency model is unchanged.
