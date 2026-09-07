// npm plugin entry — opencode loads the package main, which must export
// the plugin WITHOUT starting the Telegram bot (no side effects on import).
export { TelegramGatewayPlugin } from "./src/plugin.js";
