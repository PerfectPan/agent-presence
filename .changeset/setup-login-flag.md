---
"@rivus/agent-presence": patch
---

Avoid repeated QR login during setup by reusing existing credentials. Setup still starts login when credentials are missing, `--skip-login` keeps hook repair login-free, and `--login` forces fresh authentication.
