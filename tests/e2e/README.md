# Browser tests (no npm deps)

Both scripts drive a real Chrome over the DevTools protocol with the unpacked extension loaded.
Branded Google Chrome ≥ 137 ignores `--load-extension`, so use **Chrome for Testing**:

```sh
npx -y @puppeteer/browsers install chrome@stable --path /tmp/cft
export CHROME_BIN="$(find /tmp/cft -type f -name 'Google Chrome for Testing' | head -1)"
scripts/fetch-vendor.sh                # once; OCR runtime
node tests/e2e/ocr-smoke.mjs           # offscreen doc + tesseract: warm, OCR, crop, host perms, close
node tests/e2e/grid-find.mjs           # fake grade-page server + real grid.js: find/OCR filtering end to end
```

Add `--headful` to `ocr-smoke.mjs` to watch it. Unit tests: `node --test 'tests/*.test.mjs'`.
