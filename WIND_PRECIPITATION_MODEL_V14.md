# Wind + precipitation v14

## Wind
- Each weather sample now has a local road heading.
- Wind is projected onto that local heading rather than using one A→B bearing for the whole route.
- Wind vectors are averaged using sin/cos components; compass angles are never averaged as plain numbers.
- The aerodynamic model continues to use relative air speed, with the existing conservative tailwind floor.

## Precipitation
- Rain impact now varies continuously with precipitation intensity rather than jumping only between fixed 8%/12% buckets.
- Snow impact also varies with intensity, while heavy-snow WMO codes retain a conservative floor.
- Seasonal daily precipitation is converted to an hourly-equivalent intensity before entering the road-surface model, so daily mm are not mistaken for mm/h.
