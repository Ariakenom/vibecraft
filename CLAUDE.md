# Notes for Claude

- A message that starts with "todo:" is something to write down, not to do
  now: add it to `docs/todo.md` under "Waiting" (in a sentence or two, with
  anything you know that will help later), commit, and carry on with what
  you were doing. Only work on a to-do when asked to.
- The UI must not move under the player's mouse. Anything that changes
  while it's on screen keeps its size, so nothing next to it shifts:
  - A control that comes and goes keeps its space: hide it with
    `visibility: hidden` (a class), not the `hidden` attribute, which is
    `display: none !important` here (index.html) and collapses it.
  - A button whose text changes ("Cheat mode: off/on", "Surrender" /
    "Really surrender?") holds all its texts with `stableLabels` and
    switches with `showLabel` (main.js), so it's always as wide as the
    longest.
  - Numbers that change get `font-variant-numeric: tabular-nums` and a
    fixed width.
  - Check by screenshotting before and after the change (same element
    boxes: `getBoundingClientRect` of the neighbours).
