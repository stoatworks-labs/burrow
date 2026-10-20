# AGENTS.md — Stoatworks Burrow

Orientation for an AI assistant, or a human, picking this repo up cold.

---

## 1. What this is

An optional desktop app that installs, updates and removes the fleet's software:
plugins, applications and Companion modules. Tauri v2: Rust behind, React +
TypeScript in front.

It exists because installing one of these by hand means choosing between six
archives per video plugin and knowing three different destination directories, two
of which need an administrator password — and then something different again for an
audio plugin, an application and a Companion module.

**Six tabs.** Video plugins, Video tools, Audio, Networking & Infrastructure,
Self-hosted, and Device firmware — which, unlike the other five, writes to a
device rather than to a folder: a CANary over its USB serial port, a BirdDog PLAY
over Rockchip USB, and the PLAY's update packages. That tab has rules of its own,
in §3a. The tab is a field on each catalogue entry, chosen
by the website from the fleet's own `category` data — see §4. **Self-hosted cuts
across the others**: anything that ships a `docker-compose.yml`, and every
browser tool, sits there whatever it is for, because how you run a thing decides
what its row can offer. A `kind: "web"` entry installs nothing — its row is
Open, Source and Run your own — and it is the one kind with no assets, which
three gates in the catalogue route once dropped silently (docs/NOTES.md,
2026-08-25).

**It is a client, not a service.** There is no account, no telemetry and no
backend. One HTTPS GET for the plugin list, and downloads straight from GitHub —
plus, only when someone asks for them in the Firmware tab, Tailscale's own download
server and a PLAY on the local network. Anything that would change that is a change
to the product, not an implementation detail — see §6.

## 2. Layout

```
crates/burrow-plan/     The file-operation vocabulary the privileged helper
                        accepts, and the validator both sides run. No I/O.
crates/burrow-helper/   The binary that runs as root. Depends on burrow-plan,
                        serde and libc — and must never depend on more.
crates/burrow-core/     Catalogue model, host detection, archive handling, disk
                        images, quarantine, commit/rollback, the install ledger
                        and reconciliation. Free of Tauri, so it is all
                        unit-testable.
crates/burrow-device/   Writing firmware to devices: the CANary (ESP32-S3, via
                        espflash) and the PLAY (Rockchip USB, via nusb), the
                        gates in front of both, and the PLAY's package builder.
                        No Tauri, no HTTP, no root. See §3a.
src-tauri/              The shell: network, commands, job runner, demo server,
                        the elevation prompt, and Burrow's own updater.
src/                    React UI. Six tabs, plus a mock backend.
scripts/sync-assets.sh  Gathers the catalogue, demos, thumbnails and helper that
                        ship inside the app.
scripts/make-latest-json.mjs
                        The signed update manifest, composed at release time
                        from the artefacts. See §8.
```

The crate split **is** the security design, not tidiness. See §5.

## 3. The rules that matter

**Never glob a plugin directory.** A real `Extra Effects` folder is shared — the
one on the author's machine also holds `WebLinked.bundle`, `Metal_Gain_Example.bundle`
and five `OFX_*_Example` bundles. Burrow considers *only* the entry names the
catalogue declares for a given plugin and format. An installer that enumerates a
directory it does not own is one bug away from deleting somebody else's work.

**A payload is what the format's suffix says it is.** This is the rule that
replaced "copy every top-level entry", and it is what makes it safe to install from
an archive nobody probed: a `.vst3` for VST3, a `.component` for an Audio Unit, a
`.app` for an application, and everything else in the archive is an extra. The
audio plugins ship `VST3/`, `AU/` and `Standalone/` in one zip and each format
takes exactly its own. Two formats are named rather than recognised — a Companion
module and a Windows application are whole archives, placed under a name from the
catalogue — because a `package/` directory and a folder of DLLs have no suffix to
go on. See `Format::payload_extensions` and `payload_is_whole_archive`.

**A macOS application comes out of a disk image, not an archive.** Every GUI
application in the fleet publishes a `.dmg`; the archives beside them are
command-line binaries. That was checked, not assumed —
`oxbow-0.1.1-macos-universal.zip` holds `oxbow`, a README and a LICENCE. `dmg.rs`
mounts with `-nobrowse` on a mount point of its own choosing, takes exactly one
top-level `.app`, and detaches whichever way the copy goes.

**Symlinks inside a payload are recreated, and only inwards.** They used to be
skipped, which was right for plugins and wrong for applications: the macOS
framework layout *is* symlinks, and a `.app` copied without them is not an
imperfect copy, it is an application that does not launch. A link pointing out of
the payload fails the copy rather than being dropped — see `commit::copy_tree`.

**Never assume what an archive contains.** Four of the twenty-four ship more than
plugins: burin and flipbook include a sample asset, gridiron a folder of logos, and
cartridge a `LICENSE`, a `README.md`, a `docs/` directory and a command-line helper
binary. Copying every top-level entry would put those in the user's plugin folder
*and* make Burrow believe it owned a `LICENSE` it would later delete. Payload and
extras are separated in the catalogue and again at extraction.

**A bundle identifier says which project a payload is; a prefix does not say
whose it is.** The catalogue carries `identifiers` per entry, and that list is
the authority for claiming. `OWNED_PREFIXES` is a heuristic that is *wrong* for
four of this fleet's own namespaces — `works.stoat.weblinked`,
`com.presentationcommander.client`, a bare `wsm-wwb-bridge` and a bare
`resolve-configurator-gui`, all read off a real disk rather than assumed. It
was also missing `com.stoatworkslabs.` entirely, which is what Burrow itself
ships. Never add a prefix rule where an identifier list will do.

⚠️ **Claiming is the one place Burrow reads a directory it does not own**, and
it is allowed because it only ever produces *candidates to show a person*.
Nothing in `claim.rs` writes, moves or deletes; a candidate becomes a ledger
entry only when the user picks it, and only an identifier the catalogue lists
gets as far as being offered — a far narrower test than the name matching used
everywhere else. Do not reuse that scan for anything that acts on what it
finds.

**Never hardcode a bundle name.** downpour ships `Downpour.bundle` *and*
`Downpour Over.bundle`; orrery, vectrix, idler, coinop, burin and flipbook all ship
a second bundle too. Names come from the catalogue, which reads them out of each
archive's central directory at release time.

**The plist beats the ledger.** The ledger records what Burrow installed; the disk
records what is there. They diverge — a locally built `Tinsel.bundle` on the
author's machine reports `0.2.0` against a `1.0.2` release. The disk wins, because
the disk is what the host will load. The ledger is trusted only for payloads that
carry no readable version (every Windows one), and only while the bytes still hash
to what it recorded.

**Clear quarantine unconditionally, on the staged copy.** A quarantined plugin is
skipped *silently* by Resolume — no prompt, it simply is not in the list. The flag
is inherited from the writing process, so an app that was itself downloaded marks
everything it writes. That case cannot be reproduced from a local build, which is
exactly why the clearing is not conditional. Doing it in staging also means the
privileged helper never needs the capability.

**Nothing is ever written into a live path.** Extract, validate, de-quarantine and
hash in staging; then rename the old payload aside and rename the new one in. A
host that rescans mid-install sees the old plugin or the new one, never a
`Contents/` without a binary. Staging happens *inside* the destination directory so
the rename cannot fail with `EXDEV` across filesystems.

**The signature is what an update is trusted on, not the address.** Burrow's own
updater verifies `latest.json` and the artefact it names against a minisign public
key compiled into the binary from `tauri.conf.json`. HTTPS and the github.com
hostname are not the check — an update that does not verify is refused whoever
served it. That is also why the manifest is built by the release workflow rather
than written by hand, and why `make-latest-json.mjs` fails the release outright
when any platform's artefact or signature is missing: a manifest with two of three
platforms in it makes every copy on the third report *the platform was not found*
— an error about our release, shown to someone who cannot act on it, on every
check until it is noticed.

⚠️ **The macOS updater tarball is made after the re-sign, not by Tauri.** Same
trap as the .dmg — `tauri build` signs the bundle before the bundler places
`Contents/Resources`, so `createUpdaterArtifacts` would ship the stale signature
`scripts/release-lib.sh` exists to repair. The workflow tars the staged, re-signed
copy and signs that. Do not turn `createUpdaterArtifacts` on to "simplify" it.

**Only Arena and Avenue are plugin destinations.** Alley and Wire link the same
FFGL engine but do not scan an `Extra Effects` folder — established by `strings` on
the binaries, not by assumption. They are detected and reported, never offered.

**Resolve `Documents` through the known-folder API.** On a Windows machine with
OneDrive folder backup — a common default — `%USERPROFILE%\Documents` is not where
Documents is, and a string join installs into a folder Resolume never reads.

**Writability is probed, never inferred.** Adobe's `MediaCore` is `drwxrwxr-x
root:wheel`, which reads as group-writable and is not, for a user in `staff` and
`admin` rather than `wheel`. Anything short of creating a file gets this wrong.

## 3a. Device firmware

A device write is not a file install. There is no staging copy to inspect, no
rename to back out of, and no ledger entry that means anything — the device is
the record. So the safety is up front, and it is all in `burrow-device`, where
`cargo test` reaches it without a unit.

**None of it is near the helper.** Writing to a serial port or a USB device needs
no root on macOS, `burrow-device` is not a dependency of `burrow-helper`, and must
never become one. The folder-install machinery in `jobs.rs` does not touch a
device either: `Format::Firmware` exists so the catalogue can carry firmware, and
is **left out of `Format::SHIPPING`** so the slots, the default formats and
Install/Update all can never sweep a device in. A test in `settings.rs` pins it.

**Nothing looks for a device unless asked.** Opening a CANary's port resets the
ESP32-S3 (USB-Serial-JTAG does that), and probing a PLAY claims it. Both are
buttons; neither is something to do to a unit nobody pointed Burrow at, and a
background scan would be both.

**The gate runs twice.** Once when the confirmation is drawn, and again inside
`Unit::write` against a fresh read of the unit, immediately before the first byte
— a board swapped between the two is a different board. The CANary's gate is the
CANary Flasher's `checkPlan`, rule for rule and message for message (its tests are
ported too), plus what the page left to its README: an 8 MB part, the slot read
from the unit's *own* partition table, and a refusal when secure boot or flash
encryption is on. A unit that boots something other than CANary firmware is not
refused — a blank board is how every CANary starts — but the confirmation names it
and needs a tick.

**Firmware is only written if the catalogue vouches for its bytes.** The asset's
`sha256` (GitHub's own digest, carried by the catalogue) is required for anything
the Firmware tab downloads. A plugin can be inspected in staging; firmware goes to
the device, so this is the check.

**A write cannot be cancelled.** Stopping half way through a partition is worse
than finishing it, and both devices recover from a failed write the same way they
recover from a good one: by being written again. The interface says so before the
write, not after.

**CANary.** Only the four regions a release carries are written, so NVS (the
unit's name, port and LAN address), phy_init, ota_1 and the coredump survive
unless the user turns off "Keep this unit's settings", which erases the lot.
Flash mode, frequency and size are never patched (espflash writes raw bytes; the
check below would catch it if that ever changed). After writing, every region is
checked with an MD5 of our own against the unit's — not espflash's word for it.
The unit is restarted whether or not the write finished. The USB network variant
turns the port into a network adapter 8 s after boot; the next write needs BOOT+EN.

**PLAY.** The factory image and the loader inside it are BirdDog's, and only ever
come from the user's own file: Burrow never ships or downloads either, and a
change that bundles a loader "for convenience" is the moment this stops being
publishable. Three things learned on a unit (fleet notes, 2026-08-15) are in the
code and must stay: the mode is **probed with a read**, not taken from bcdUSB,
because a loader-mode unit can carry the maskrom bit and a loader pushed into a
running loader hangs it; the maskrom 0x471/0x472 push **claims nothing** on macOS
and Linux, because claiming first made 472 time out every time; and **whole
partitions only, never a delta**, verified only below the read ceiling (sector
0x10000 on a PLAY, above which every read is 0xCC fill whatever is there). That is
also why the plan said "rockusb" and the code does not use it: its constructor
claims the interface.

**The PLAY ports are byte-identical to the web tools.** `gpt.rs`, `ext2.rs`,
`inject.rs` and the package tar produce the same bytes as the browser flasher's and
patcher's own modules on the same inputs. `scripts/crosscheck-play.mjs` proves it;
re-run it when either side changes (§7). Two departures from the JS, both only
safer: the ext2 group descriptor table is found at `first_data_block + 1` (the
page's formula is wrong for 4 KiB blocks, though right for the PLAY's 1 KiB), and a
new inode's record is zeroed before it is filled.

**Windows.** A Rockchip device needs the WinUSB driver bound (Zadig); Burrow
detects the wrong driver and says so, and never installs one — that would be a new
elevated path. WinUSB has no device-level control transfer, so the maskrom push
there goes through a claimed interface, which is exactly the claim that broke 472
on a Mac. That path is unproven until it has run on a Windows x64 machine.

**Sending a package to a PLAY** is a BirdUI login (`POST /login`,
`auth_password`) and the System Update form (multipart `POST /settings`,
`update_file`, `button=update`) at an address the user typed — a host name or an
IPv4 address and nothing else — then a bounded wait for the unit's front page to
answer again. Plain HTTP, because that is all BirdUI speaks. The password is used
for that send and kept nowhere. All of it is in `net.rs`, with every other
request this app makes.

**Wording.** Public text never names the product the CANary stands in for, its
model numbers or its control application ("the control application"; "the d&b
amplifier ecosystem" where compatibility needs saying). The PLAY's sections carry
the flasher's non-affiliation line.

## 4. The catalogue

Burrow reads `stoatworks-labs.com/catalog.json`, which the **website** generates at
build time (`src/pages/catalog.json.ts`) from `projects.json` + `downloads.json` —
the same arrangement as `releases.xml.ts` and `llms.txt.ts` there. It therefore
cannot advertise a version the download tables disagree with.

**Four kinds and three categories, decided there and not here.** `kind` is
`plugin`, `app`, `companion` or `web`; `category` is `video`, `audio` or `netinfra`,
folded from the fleet's eight categories by a priority list in that route. When something
looks filed oddly in the app, the fix is usually its `category` in `projects.json` —
which the website itself reads too — rather than a special case in Burrow.

⚠️ **`assets` is additive beside `builds`, never inside it.** `builds` is
format → platform → one asset, which cannot express the separate arm64 and x64
builds almost every application ships. Nesting a third level would have changed the
shape of a field shipped clients already parse, and a website deploy has stopped
every copy of Burrow in the field from reading the catalogue once already. So the
flat, arch-aware list sits beside the map, is preferred where present, and is
ignored by anything that has never heard of it. `builds` is *derived* from it, so
the two cannot drift.

**Payload names are only known for the video plugins.** `gen-catalog-data.py` probes
their archives at release time; nothing probes an application, an audio plugin or a
Companion module. So `reconcile_one` takes `has_asset` separately from `declared`:
an artefact with no declared names is *offered*, not reported as "no build". Burrow
learns the names when it installs, and until then cannot see a hand-installed copy —
a degraded answer, not a wrong one.

Two things a build-time route cannot know come from
`stoatworks-backend/release/gen-catalog-data.py`, run at release time: release
notes, and what each archive unpacks to. The second is read from the archives'
central directories over HTTP range requests — 62 KB for all 77 archives, rather
than 40 MB of downloads.

**Firmware is a fifth kind.** `kind: "firmware"`, with `category` and `tab` both
`firmware` (so a client from before the tab split files it under the placeholder
rather than under Audio), a `device` naming which device it is written to
(`canary`, `birddog-play`; an unknown one is shown and not offered), and assets in
`format: "firmware"`, one zip repeated per published platform with arch `universal`
like a Companion module. Every asset now carries an additive `sha256` from GitHub's
digest; firmware is refused without one. The website emits a firmware entry only
for a project with a public repo and a `device`, so the firmware projects that are
not written by Burrow stay out. What is inside the two zips is fixed:

- **CANary** (`stoatworks-labs/canary` releases): `manifest.json` in the CANary
  Flasher's own shape with one release, and the parts under
  `<release-id>/<variant>/`. Exported from the flasher's `public/firmware/`, so
  the page and Burrow cannot disagree about a release.
- **PLAY patcher kit** (`stoatworks-labs/birddog-play-patcher` releases):
  `kit.json` (format, version, the MediaMTX pin, where Tailscale comes from, the
  reserved module names), the patcher's own `assets/` with its `manifest.json`,
  and `NOTICES/`. Burrow packs the .fw member for member as the page's `app.js`.

**A copy of the catalogue ships inside the app.** Not a nicety: it makes a first
run work offline, it is the baseline that stops "What's new" announcing all
twenty-four plugins on first launch, and the GitHub fallback cannot *discover*
which repos exist without it.

## 5. The privileged helper

OpenFX and Adobe plugins go into root-owned directories with no user-writable
alternative any host looks in, so something has to run as root. `burrow-helper` is
the smallest thing that can.

Its dependency list is the security statement: `burrow-plan`, `serde` and `libc`.
No HTTP client. No zip decoder. **If anything else ever appears in that table,
something has gone wrong with the design.**

It accepts four operations — `ensure_root`, `replace`, `retire`, `purge` — chosen
so that "delete an arbitrary path as root" is not expressible. Uninstall is
`retire` then `purge`, and `purge` refuses anything whose name does not end in the
current plan's random nonce. You can only delete what you just renamed.

Every destination must be a **direct child, exactly one component deep**, of a
compiled-in whitelist. Not a descendant — a child. A user-configured custom
destination is *never* elevated, so a tampered settings file cannot aim a root
write; the whitelist is a `const`, and settings never reach it.

`crates/burrow-plan/src/lib.rs` has the tests. Add to them before changing
anything there.

## 6. Things that would change what this app *is*

Flag these rather than implementing them quietly:

- Any network request beyond the catalogue, GitHub downloads and the update
  manifest — and that last one only when the user asks, or at startup if they
  turned the checkbox on — plus the two the Firmware tab makes when asked:
  `pkgs.tailscale.com` for a package with Tailscale in it, and a PLAY's BirdUI at
  an address the user typed. Nothing here polls; the one loop, waiting for a PLAY
  to come back after a send, is bounded and follows a click.
- Looking for devices in the background, or installing a driver.
- Anything that identifies the user or the machine.
- Reading the plugin directory rather than named entries.
- Widening the helper's whitelist, its operation set, or its dependencies.
- Removing the `connect-src 'none'` the demo server sends.

**The audio, application and Companion formats added no elevated path.** That was a
decision, and it is why `/Applications` is not in the helper's whitelist: a standard
user cannot write there, and the answer is `~/Applications` — which macOS indexes
identically — rather than teaching the one component that runs as root to delete
things in the directory holding every application on the machine. Windows VST3 goes
to the per-user location in the VST3 spec for the same reason. There is a test
pinning it: `no_format_added_for_the_new_categories_can_ask_for_a_password`.

## 7. Testing

```bash
cargo test --workspace     # the library crates, burrow-device included: no Tauri, every platform
(cd src-tauri && cargo test)   # the shell: settings, demo server, updater
npm run build              # type-checks the UI

# What CI actually gates on, and what a Mac-only run does not tell you.
cargo clippy --workspace --all-targets -- -D warnings
cargo clippy --workspace --all-targets --target aarch64-pc-windows-msvc -- -D warnings
```

⚠️ **Run clippy for a non-macOS target too.** CI runs it on macOS, Windows *and*
Ubuntu, and `-D warnings` means dead code is a build failure. Everything behind
`cfg(target_os = "macos")` — the disk-image path, most of `dmg.rs` — is dead code
on the other two, and a local run on this Mac reports none of it. CI was red for
three releases before anyone noticed.

The UI runs in an ordinary browser against a mock backend, which is how the
awkward states get looked at:

```
?tab=whatsnew|video-plugins|video-tools|audio|netinfra|selfhosted|firmware|settings   (`plugins`, `video` = video-plugins)
?installed=tinsel:ffgl@0.2.0,idler:ffgl@?     behind / current / unknown version
?ofx=missing|empty|readonly|ok                the OpenFX destination's condition
?state=ok|offline|error                       what the last refresh did
?job=ok|failed|cancelled
?update=none|available|blocked|error|fail        a newer Burrow, or not
```

The Firmware tab has its own (`src/api/mockFirmware.ts`):

```
?device=both|none|canary|canary-old|canary-foreign|blank|s3-small|play-maskrom|play-loader|play-win-nodriver
?fw=ok|fail                                    whether a write gets to the end
```

`burrow-device`'s tests run the CANary gate against the real `main-ff4110d`
parts, restore a whole PLAY image (with a real mke2fs-made ext2 rootfs) into a
`Vec` standing in for the eMMC, and check the injected filesystem with
`e2fsck -fn` where e2fsprogs is installed. Two runs that are not CI:

```bash
# The PLAY ports against the web tools' own modules, byte for byte.
cargo run -p burrow-device --example crosscheck -- /tmp/xc
node scripts/crosscheck-play.mjs /tmp/xc <birddog-play-flasher> <birddog-play-patcher>

# Against the release zips Burrow will really download, unpacked.
BURROW_CANARY_DIR=… BURROW_PLAY_KIT_DIR=… \
  cargo test -p burrow-device --test real_artefacts -- --ignored
```

Same idea as av-launcher's `mockInvoke`, and for the same reason: a screenshot of
"the password prompt was cancelled" should not require cancelling a password
prompt.

**What only a real machine can settle:** the authorisation prompt end to end;
whether a plugin Burrow installed actually appears in Resolume, Resolve and After
Effects; and quarantine clearing, which needs a *downloaded* copy of the app,
because a locally built one is never quarantined. And every device write: a CANary
on the bench, a PLAY in loader mode and in maskrom, a package sent to BirdUI, an
injected package installing on first boot, and anything at all on Windows.

## 8. Releasing, and the update key

Tagging `v*` builds both macOS architectures and Windows, packages them, and
publishes the release. Two things now happen that did not before:

1. Each platform's **update artefact** is signed — the staged macOS `.app.tar.gz`
   and the Windows `-setup.exe` — with `tauri signer sign`.
2. After the release exists, `scripts/make-latest-json.mjs` composes `latest.json`
   from those artefacts *and the release's own body*, and uploads it. A final step
   fetches the `/releases/latest/download/latest.json` URL that is compiled into
   every installed copy and asserts it serves this version, for all three
   platforms.

⚠️ **The release fails without `TAURI_SIGNING_PRIVATE_KEY`.** Deliberately.
A release published with no manifest would leave every installed copy asking a
404 and reporting that it could not check — and one published with a manifest
signed by the wrong key would be worse, because the app would refuse the update
it was offered and there would be nothing to do about it but re-cut the release.

**The update artefact is signed twice, by two different things, and both
matter.** The minisign signature above is what the app checks. Apple's is what
macOS checks — and CI cannot make it, because the Developer ID key never leaves
the author's Mac. So the tarball CI publishes carries an **ad-hoc signed** app,
and `posthoc-sign.sh` in stoatworks-backend replaces it within one auto-sign
tick: unpack, Developer ID sign, notarise, staple, repack, **re-sign with the
minisign key and rewrite `latest.json`**. Those last two are not optional — a
repacked tarball under its old signature is refused by every installed copy.

Without that half, the download and the in-app update disagreed: a user who
took the notarised `.dmg` and then pressed *Install and restart* was moved to
the ad-hoc build, silently. See stoatworks-backend's `docs/NOTES.md`,
2026-08-25.

⚠️ **Do not rename the update artefacts to something not ending in
`.app.tar.gz`.** That suffix, plus a sibling `.sig`, is exactly what
`posthoc-sign.sh` and `verify-signing.sh` match on. Rename it and both go
quiet: the release still publishes, the app still updates, and every update
from then on is ad-hoc signed with nothing reporting it.

The private key lives outside this repo (`~/keys/burrow-updater.key` on the
author's machine) and in the repository secrets as `TAURI_SIGNING_PRIVATE_KEY`,
with `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` empty. Its public half is in
`tauri.conf.json` and is compiled into every build.

**Losing the private key means no installed copy can ever be updated again** —
they verify against the public half they were built with. Replacing it is a new
public key, a new build, and a manual download for everybody already out there.

## Notes

`docs/NOTES.md` carries this repo's working notes — current status, decisions
already made, and the traps that have actually bitten. Read it before changing
anything non-obvious. Cross-cutting fleet knowledge lives in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).
