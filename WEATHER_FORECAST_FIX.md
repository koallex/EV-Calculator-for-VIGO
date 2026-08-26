# Long-range weather fix

The previous implementation used `forecast_days` against the Open-Meteo seasonal endpoint. The seasonal API uses `forecast_months` (6 by default, up to 7), so long-range requests could fail even though the selected date was within the supported seasonal horizon.

The route planner now requests `forecast_days=217` and matches the selected route sample's calendar date against the returned daily series. Operational forecasts remain hourly for dates within 16 days.
