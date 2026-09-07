# Contributing

1. Fork, branch, PR — small focused diffs please.
2. `npm install && npm test` must pass.
3. New Telegram commands: add the handler in `src/index.js`, the logic in `src/opencode-service.js`, and document it in `README.md`.
4. Never commit `.env` or tokens. Security-sensitive changes (auth, CLI passthrough, permissions) need extra review.
5. Be kind. MIT licensed.
