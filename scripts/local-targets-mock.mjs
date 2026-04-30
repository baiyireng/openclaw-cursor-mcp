#!/usr/bin/env node
const targets = [
  {
    targetCursor: "cursor-window-main",
    workspacePath: process.cwd(),
    windowLabel: "Main Workspace",
    active: true
  },
  {
    targetCursor: "cursor-window-side",
    workspacePath: process.cwd(),
    windowLabel: "Side Workspace",
    active: false
  }
];
process.stdout.write(JSON.stringify(targets));
