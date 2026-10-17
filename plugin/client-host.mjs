/**
 * Host half of the settings row.
 *
 * The settings page itself is the `./client` bundle served to the DSH web UI; this
 * module only has to exist so the row has a host-safe import. The package root used to
 * point at `src/main.js` — the Electron app entry — which the DSH host process cannot
 * import (`require('electron')` has no app there), so the row failed to start and the
 * settings section never mounted.
 */
export const name = 'dsh-floatball-pet-client'
export const inject = []

export function apply() {
  // Nothing runs here: the host row owns the ball and its HTTP routes, the client row
  // owns the settings UI. This half exists only to be importable.
}
