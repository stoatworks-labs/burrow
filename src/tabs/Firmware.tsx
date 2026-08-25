/**
 * Device firmware — a tab with nothing in it yet, saying so.
 *
 * The fleet has nine firmware projects, and none of them are things Burrow can
 * responsibly install today: writing firmware to a device is not the same risk
 * as copying a bundle into a folder, and a half-finished write is not something
 * a rollback fixes. So the tab exists ahead of the capability, deliberately —
 * it is where people will look, and "coming soon" in the place you looked is a
 * better answer than a tab that is not there.
 *
 * The category id is already carried end to end: the catalogue can emit
 * `firmware` entries whenever it starts to, and this build files them
 * correctly. What it cannot yet do is flash one.
 */
export function Firmware() {
  return (
    <div className="empty">
      <strong>Coming soon</strong>
      Firmware for the fleet&rsquo;s devices will be installable from here.
    </div>
  )
}
