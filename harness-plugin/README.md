# dsh-plugin-local-ocr

Install this Harness bundle from npm after setting up the local OCR Runtime:

```powershell
npx dsh-local-ocr-runtime setup --yes
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile local-ocr add @deepseek-ai/dsh-web-app@0.1.0-rc.6
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile local-ocr add dsh-plugin-local-ocr
```

Custom Harness profiles start without the browser bundle, so install the Web
bundle before this OCR bundle when the profile will serve the 3081 UI. The
bundle registers `vision_read`, `vision_read_region`, and the
`deepseek-local-ocr` text-only bridge. It accepts only session-authorized PNG,
JPEG, and WebP attachments by default. It does not select a default model:
choose `Local OCR Bridge` in Harness, then select any available upstream model
from the dynamically discovered provider catalog. See the repository README
for runtime, privacy, and troubleshooting details.
