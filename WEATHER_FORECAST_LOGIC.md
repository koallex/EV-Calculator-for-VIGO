# Weather forecast logic

- 0–16 days: operational Open-Meteo hourly forecast, matched to the estimated time at each route sample.
- Beyond 16 days: ECMWF seasonal forecast via Open-Meteo. The seasonal endpoint is requested with forecast_days=217 (not forecast_days) and the app selects the exact returned calendar date, using daily mean temperature, daily precipitation, mean wind speed and dominant wind direction.
- Long-range seasonal data is an area-scale estimate, not a precise local hourly forecast. Open-Meteo documents SEAS5/EC46 seasonal coverage out to 7 months and notes that the data are not bias-corrected.
- The app never silently substitutes today's/nearest available weather when the selected date is outside the returned forecast range; it returns unavailable instead.
