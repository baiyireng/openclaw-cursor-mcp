#!/usr/bin/env node
const [, , sessionId = "", message = "", targetCursor = ""] = process.argv;
const reply = [
  "LocalCursorMock:",
  `session=${sessionId}`,
  `target=${targetCursor || "default"}`,
  `message=${message}`
].join(" ");
process.stdout.write(reply);
