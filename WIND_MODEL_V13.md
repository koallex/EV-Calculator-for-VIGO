# Wind model v13

Tailwind was producing an excessive aerodynamic credit at low road speeds because relative air speed can become very small. The v13 model keeps the vector air-speed calculation but uses a more conservative aerodynamic share and a 22% minimum total-road-load floor for tailwind. This prevents a stronger tailwind from making higher road speeds cheaper than lower speeds purely through the wind multiplier.

The model still distinguishes headwind, tailwind and crosswind and calculates aerodynamic drag from relative air speed squared. The tailwind floor applies only to the wind adjustment; HVAC remains time-based and is calculated separately.
