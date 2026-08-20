# Privacy and Security

- The plugin sends image bytes only to the configured loopback OCR Runtime.
- The Runtime binds to `127.0.0.1` and rejects arbitrary paths, URLs, and
  non-loopback service URLs.
- Model downloads are visible, require explicit consent, and are cached in the
  user runtime directory rather than the repository.
- Harness attachments are authorized against the current session. Direct file
  OCR is disabled unless an explicit allowed directory is configured.
- OCR text is untrusted external evidence. It cannot change system rules,
  grant tool permissions, or override the user request.
- Logs do not contain image bytes, Base64, tokens, or complete OCR text.
- If the bridge delegates to a cloud text model, the OCR text (not the image
  bytes) enters that model's context. Use a supported local text model when
  OCR text must remain on the machine.
