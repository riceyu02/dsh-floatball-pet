'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  /** Initial snapshot: preferences, layout, hover state and the first data reading. */
  ready: () => ipcRenderer.invoke('pet:ready'),
  /** Force a balance / process refresh and resolve with the new snapshot. */
  refresh: () => ipcRenderer.invoke('pet:refresh'),
  /** Launch DeepSeek Harness, or focus it when it already runs. */
  openDsh: () => ipcRenderer.invoke('pet:open-dsh'),
  /** Open a file picker for the ball image (static picture or animated GIF). */
  pickBallImage: () => ipcRenderer.invoke('pet:pick-ball-image'),
  /** Go back to the built-in ball art. */
  clearBallImage: () => ipcRenderer.invoke('pet:clear-ball-image'),
  /** Persist one or more preference changes. */
  set: (patch) => ipcRenderer.send('pet:set', patch),
  /** Report the measured settings-panel box so the window can reserve room. */
  setMetrics: (metrics) => ipcRenderer.send('pet:metrics', metrics),
  /** Debug only: report what the renderer's DOM actually looks like. */
  probe: (data) => ipcRenderer.send('pet:probe', data),
  /** Ask the main process to show or hide the settings panel. */
  setPanel: (open) => ipcRenderer.send('pet:set-panel', open),
  /**
   * Tell the main process a press started (true) or ended (false).
   * `moved` separates a real drag from a plain click, so the island is only
   * cleared away for the former.
   */
  setDragging: (active, moved) => ipcRenderer.send('pet:drag', active, moved),
  /**
   * Report the horizontal correction currently applied so the ball is drawn where
   * the main process says it is. Diagnostics only: it should be 0 except for the
   * frame or two around the island swapping sides.
   */
  reportBallFix: (dx) => ipcRenderer.send('pet:ball-fix', dx),
  /**
   * Tell the main process the new ball packing is on screen, so it may now move the
   * window. Until this arrives main deliberately holds the window still — moving it
   * first is what made the ball flash sideways when the island swapped sides.
   */
  layoutApplied: () => ipcRenderer.send('pet:layout-applied'),
  /** Subscribe to a layout handed over on its own, ahead of the full snapshot. */
  onLayout: (callback) => {
    const listener = (_event, layout) => callback(layout);
    ipcRenderer.on('pet:layout', listener);
    return () => ipcRenderer.removeListener('pet:layout', listener);
  },
  /** Move the pet so the ball's centre lands on this screen point. */
  moveTo: (centerX, centerY) => ipcRenderer.send('pet:move-to', { centerX, centerY }),
  /** Quit the pet. */
  quit: () => ipcRenderer.send('pet:quit'),
  /** Subscribe to pushed data / layout snapshots. */
  onSnapshot: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('pet:snapshot', listener);
    return () => ipcRenderer.removeListener('pet:snapshot', listener);
  },
  /** Subscribe to hover / panel state driven by the main process cursor poll. */
  onHover: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('pet:hover', listener);
    return () => ipcRenderer.removeListener('pet:hover', listener);
  },
  /** Subscribe to the animated ball size (one message per animation frame). */
  onSize: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('pet:size', listener);
    return () => ipcRenderer.removeListener('pet:size', listener);
  },
});
