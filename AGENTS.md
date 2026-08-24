# AGENTS.md — Stoatworks Burrow

Orientation for an AI assistant, or a human, picking this repo up cold.

---

## 1. What this is

An optional desktop app that installs, updates and removes the fleet's video
plugins. Tauri v2: Rust behind, React + TypeScript in front.

It exists because installing one of these plugins by hand means choosing between
six archives per plugin and knowing three different destination directories, two
of which need an administrator password.

**It is a client, not a service.** There is no account, no telemetry and no
backend. One HTTPS GET for the plugin list, and downloads straight from GitHub.
Anything that would change that is a change to the product, not an implementation
detail — see §6.

## 2. Layout

```
crates/burrow-plan/     The file-operation vocabulary the privileged helper
                        accepts, and the validator both sides run. No I/O.
crates/burrow-helper/   The binary that runs as root. Depends on burrow-plan,
                        serde and libc — and must never depend on more.
crates/burrow-core/     Catalogue model, host detection, archive handling,
                        quarantine, commit/rollback, the install ledger and
                        reconciliation. Free of Tauri, so it is all unit-testable.
src-tauri/              The shell: network, commands, job runner, demo server,
                        the elevation prompt.
src/                    React UI. Three tabs, plus a mock backend.
scripts/sync-assets.sh  Gathers the catalogue, demos, thumbnails and helper that
                        ship inside the app.
```

The crate split **is** the security design, not tidiness. See §5.

## 3. The rules that matter

**Never glob a plugin directory.** A real `Extra Effects` folder is shared — the
one on the author's machine also holds `WebLinked.bundle`, `Metal_Gain_Example.bundle`
and five `OFX_*_Example` bundles. Burrow considers *only* the entry names the
catalogue declares for a given plugin and format. An installer that enumerates a
directory it does not own is one bug away from deleting somebody else's work.

**Never assume what an archive contains.** Four of the twenty-four ship more than
plugins: burin and flipbook include a sample asset, gridiron a folder of logos, and
cartridge a `LICENSE`, a `README.md`, a `docs/` directory and a command-line helper
binary. Copying every top-level entry would put those in the user's plugin folder
*and* make Burrow believe it owned a `LICENSE` it would later delete. Payload and
extras are separated in the catalogue and again at extraction.

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

**Only Arena and Avenue are plugin destinations.** Alley and Wire link the same
FFGL engine but do not scan an `Extra Effects` folder — established by `strings` on
the binaries, not by assumption. They are detected and reported, never offered.

**Resolve `Documents` through the known-folder API.** On a Windows machine with
OneDrive folder backup — a common default — `%USERPROFILE%\Documents` is not where
Documents is, and a string join installs into a folder Resolume never reads.

**Writability is probed, never inferred.** Adobe's `MediaCore` is `drwxrwxr-x
root:wheel`, which reads as group-writable and is not, for a user in `staff` and
`admin` rather than `wheel`. Anything short of creating a file gets this wrong.

## 4. The catalogue

Burrow reads `stoatworks-labs.com/catalog.json`, which the **website** generates at
build time (`src/pages/catalog.json.ts`) from `projects.json` + `downloads.json` —
the same arrangement as `releases.xml.ts` and `llms.txt.ts` there. It therefore
cannot advertise a version the download tables disagree with.

Two things a build-time route cannot know come from
`stoatworks-backend/release/gen-catalog-data.py`, run at release time: release
notes, and what each archive unpacks to. The second is read from the archives'
central directories over HTTP range requests — 62 KB for all 77 archives, rather
than 40 MB of downloads.

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

- Any network request beyond the catalogue and GitHub downloads.
- Anything that identifies the user or the machine.
- Reading the plugin directory rather than named entries.
- Widening the helper's whitelist, its operation set, or its dependencies.
- Removing the `connect-src 'none'` the demo server sends.

## 7. Testing

```bash
cargo test --workspace     # 98 tests, no Tauri, every platform
npm run build              # type-checks the UI
```

The UI runs in an ordinary browser against a mock backend, which is how the
awkward states get looked at:

```
?tab=whatsnew|plugins|settings
?installed=tinsel:ffgl@0.2.0,idler:ffgl@?     behind / current / unknown version
?ofx=missing|empty|readonly|ok                the OpenFX destination's condition
?state=ok|offline|error                       what the last refresh did
?job=ok|failed|cancelled
```

Same idea as av-launcher's `mockInvoke`, and for the same reason: a screenshot of
"the password prompt was cancelled" should not require cancelling a password
prompt.

**What only a real machine can settle:** the authorisation prompt end to end;
whether a plugin Burrow installed actually appears in Resolume, Resolve and After
Effects; and quarantine clearing, which needs a *downloaded* copy of the app,
because a locally built one is never quarantined.

## Notes

`docs/NOTES.md` carries this repo's working notes — current status, decisions
already made, and the traps that have actually bitten. Read it before changing
anything non-obvious. Cross-cutting fleet knowledge lives in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).
