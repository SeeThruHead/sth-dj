#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
// node-roon-api expects the `ws` package's WebSocket (an EventEmitter with .on()).
// Node 22+ ships a native WHATWG WebSocket; if we leave it in place node-roon-api
// uses it and crashes on `this.ws.on('pong', ...)`. Remove it so the lib's own
// `if (typeof WebSocket === "undefined") global.WebSocket = require('ws')` polyfill kicks in.
// @ts-expect-error native WebSocket present at runtime, types may not include it
delete globalThis.WebSocket
await import("../src/cli/main.ts")
export {}
