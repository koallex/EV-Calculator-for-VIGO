# HVAC / heat-pump model v10

HVAC is modeled primarily as electrical power in kW (= kWh per hour). Route HVAC energy = average HVAC power × actual trip duration. The UI reports kWh/h as the primary climate cost metric. Heating was recalibrated for a heat-pump-equipped VIGO: mild cold uses substantially less electrical power than a resistive heater; below -10°C the model gradually allows supplemental electric/PTC heating. A legacy kWh/100 km equivalent remains internally for compatibility only.
