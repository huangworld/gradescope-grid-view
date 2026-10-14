#!/usr/bin/env bash
# Download the OCR runtime (tesseract.js + wasm core + English model) into
# extension/vendor/. Nothing is loaded from a CDN at runtime; everything the
# extension needs is on disk after this script runs. Re-run after bumping versions.
set -euo pipefail

TJS=7.0.0          # tesseract.js
CORE=7.0.0         # tesseract.js-core (pin explicitly: its npm `latest` tag lags)
TD_SHA=923915d4ced2a7235221788285785a29c4a42d4a   # tesseract-ocr/tessdata_fast commit

V="$(cd "$(dirname "$0")/.." && pwd)/extension/vendor"
mkdir -p "$V/tesseract-core" "$V/lang"

dl() { # url dest
  curl -fsSL --retry 3 -o "$2" "$1"
  printf '%s  %s\n' "$(shasum -a 256 "$2" | cut -c1-16)" "${2#"$V/"}"
}

dl "https://cdn.jsdelivr.net/npm/tesseract.js@$TJS/dist/tesseract.esm.min.js"      "$V/tesseract.esm.min.js"
dl "https://cdn.jsdelivr.net/npm/tesseract.js@$TJS/dist/worker.min.js"             "$V/worker.min.js"
dl "https://cdn.jsdelivr.net/npm/tesseract.js@$TJS/dist/worker.min.js.LICENSE.txt" "$V/worker.min.js.LICENSE.txt"
dl "https://cdn.jsdelivr.net/npm/tesseract.js-core@$CORE/LICENSE"                  "$V/tesseract-core/LICENSE"
# Single-file cores (wasm inlined). The worker picks one by feature detection;
# Chrome >= 116 only ever asks for the two SIMD variants.
dl "https://cdn.jsdelivr.net/npm/tesseract.js-core@$CORE/tesseract-core-relaxedsimd-lstm.wasm.js" "$V/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js"
dl "https://cdn.jsdelivr.net/npm/tesseract.js-core@$CORE/tesseract-core-simd-lstm.wasm.js"        "$V/tesseract-core/tesseract-core-simd-lstm.wasm.js"
dl "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/$TD_SHA/eng.traineddata"        "$V/lang/eng.traineddata"
gzip -9 -n -f "$V/lang/eng.traineddata"   # tesseract.js loads <langPath>/eng.traineddata.gz

cat > "$V/VERSIONS" <<EOF
tesseract.js $TJS
tesseract.js-core $CORE
tessdata_fast eng $TD_SHA
EOF
echo "vendor ready: $(du -sh "$V" | cut -f1) in $V"
