# History SOC correction — v1.02

Added a targeted History feature for correcting the measured finish SOC of an already saved trip.

- Edit only `endSoc` from History.
- Slider is constrained to 0..startSoc.
- Quick `-10` / `+10` buttons are available.
- Saving recalculates actual energy used, kWh/100 km, km/kWh, trip cost and savings using the trip's existing tariff.
- Route, speed, weather, climate, style and other trip parameters are preserved.
- `endSocAdjustedManually` marks records that were corrected by the user.
- No consumption forecast algorithm was changed.
