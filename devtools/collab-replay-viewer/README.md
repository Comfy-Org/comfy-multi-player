# Collaboration replay viewer

This is a dev-only, read-only viewer for `comfy.collab-replay/v1` traces. It renders captured
facts and deliberately has no package build/export integration.

```sh
python3 -m http.server 6202 --directory devtools/collab-replay-viewer
```

Open `http://localhost:6202`. Load a local JSON trace or use the checked fixture. The loader
fails closed on unsupported schemas and malformed semantic steps.
