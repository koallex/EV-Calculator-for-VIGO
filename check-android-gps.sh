#!/bin/bash
# Run from project root: bash check-android-gps.sh
set -e
ROOT="${1:-.}"
MANIFEST="$ROOT/android/app/src/main/AndroidManifest.xml"
if [ ! -f "$MANIFEST" ]; then
  echo "FAIL: no android project. Run: npx cap add android"
  exit 1
fi
echo "=== AndroidManifest permissions ==="
grep -E "uses-permission|ACCESS_.*LOCATION|INTERNET" "$MANIFEST" || true
echo ""
need=(
  "android.permission.INTERNET"
  "android.permission.ACCESS_COARSE_LOCATION"
  "android.permission.ACCESS_FINE_LOCATION"
)
ok=1
for p in "${need[@]}"; do
  if grep -q "$p" "$MANIFEST"; then
    echo "OK  $p"
  else
    echo "MISSING  $p"
    ok=0
  fi
done
echo ""
if [ "$ok" -eq 0 ]; then
  echo "Adding missing permissions..."
  for p in "${need[@]}"; do
    if ! grep -q "$p" "$MANIFEST"; then
      sed -i.bak "s|<manifest\([^>]*\)>|<manifest\1>\n    <uses-permission android:name=\"$p\" />|" "$MANIFEST"
    fi
  done
  echo "Patched. Re-run sync and rebuild APK."
else
  echo "Manifest looks OK. On phone: Settings → Apps → EV Calculator → Permissions → Location → Allow (Precise)."
fi
# Geolocation plugin in capacitor
if [ -d "$ROOT/node_modules/@capacitor/geolocation" ]; then
  echo "OK  @capacitor/geolocation installed"
else
  echo "WARN  install: npm i @capacitor/geolocation @capacitor/status-bar"
fi
