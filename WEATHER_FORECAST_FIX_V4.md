# Weather forecast fix v4

The previous build still used `forecast_months=7` for the seasonal endpoint. The current Open-Meteo implementation exposes the seasonal timerange through the generic `forecast_days` parameter, with the seasonal endpoint allowing up to 217 days (~7 months).

The route planner now requests `forecast_days=217`, uses `ecmwf_seasonal_seamless`, and selects the closest calendar day (max one-day tolerance) from the returned daily series.
