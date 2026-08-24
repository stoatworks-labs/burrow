# Stoatworks Burrow

> **AI-assisted project.** This codebase was created with [Claude](https://claude.com/claude-code)
> (Anthropic), directed and reviewed by a human author. The catalogue, the install
> and uninstall paths, the archive guards and the privileged helper's refusals have
> all been exercised against real release archives on macOS. **Nothing has yet been
> installed into a live host through the finished app** — the plugin folder work is
> verified against temporary directories and the real `Extra Effects` folder is only
> ever *read*. The Windows privileged helper is not written at all. Treat it as
> unfinished.

An optional desktop app that installs, updates and removes the
[Stoatworks video plugins](https://stoatworks-labs.com/video-plugins/).

Twenty-four effects, most shipping in two or three formats — FFGL for Resolume,
OpenFX for Resolve, Vegas, Nuke and Natron, and an After Effects build. Installing
one by hand means finding the project page, working out which of six archives you
want, unzipping it, and dragging a bundle into a folder whose location differs per
format and per platform. Updating means noticing a release happened.

Burrow is one searchable list instead.

- **What's new** — release notes for updates you could take, and plugins you
  haven't seen.
- **Plugin management** — every plugin, under *Up to date*, *Update available* and
  *Not installed*, with per-format state on each row.
- **Settings** — which formats to install by default, overridable per plugin, and
  where each one goes.

Every plugin's browser demo is **built in**: press *Try demo* and it runs locally,
offline, from an address only this app knows.

## No account, and nothing phoned home

There is no sign-in, because there is nothing to sign in to.

Burrow fetches one file — the plugin list at `stoatworks-labs.com/catalog.json` —
and downloads plugin archives from GitHub. That is the whole of its network use.
It sends no identifier, no list of what you have installed, and no usage data.
The demos are served with no permission to make network requests at all.

The *Send feedback* button at the bottom of the window is the one exception, and
only when you press it.

## Installing plugins that need a password

FFGL plugins go into your own Documents folder and need nothing special.

OpenFX and After Effects plugins go into system directories — `/Library/OFX/Plugins`
and Adobe's shared `MediaCore` folder — and there is no user-writable alternative
either host will look in. So Burrow asks for an administrator password, **once per
batch**, and hands a small separate helper program a list of file moves to make.

That helper cannot do anything else. It has no network client and no archive
decoder compiled into it, it will only write inside a fixed list of plugin
directories, and it will only delete a file it has itself just renamed moments
earlier in the same operation. Everything else — downloading, unpacking, checking —
happens beforehand without any elevated rights.

Unprivileged work always runs first, so if you change your mind at the password
prompt, the plugins that did not need it are already installed.

## Status

**Not released.** What has been verified, on macOS:

- The catalogue builds from the live fleet data and serves correctly — 24 plugins,
  including the two that publish no `latest` alias and would otherwise be missing.
- Real release archives extract, validate, de-quarantine, install and uninstall
  against temporary directories — including downpour's two bundles, and cartridge's
  archive of documentation and a command-line helper alongside the plugin.
- Scanning reads this machine correctly: twelve installed plugins with versions from
  their `Info.plist`, and every foreign bundle in the same shared folder correctly
  invisible.
- The privileged helper refuses every hostile plan it was given — traversal, a path
  outside the whitelist, a forged deletion nonce, a wrong owner, a loose file mode.

What has **not**:

- No plugin has been installed into a running Resolume, Resolve or After Effects
  through the app.
- The macOS authorisation prompt has never been driven end to end.
- The quarantine clearing cannot be proven from a local build — it needs a
  downloaded, Gatekeeper-quarantined copy of the app itself.
- Windows has no privileged helper, so OpenFX and Adobe installs are refused there
  with an explanation. FFGL is unaffected.

<!-- downloads:start -->
<!-- downloads:end -->

## Building it

```bash
npm install
./scripts/sync-assets.sh    # catalogue, demos, thumbnails, the helper binary
npm run tauri dev
```

`sync-assets.sh` gathers what ships inside the app from the plugin repos and the
website checkout. It needs both alongside this one, and the website built at least
once (`npm run build` there) so `dist/catalog.json` exists.

Tests:

```bash
cargo test --workspace
```

The interesting ones are in `crates/burrow-plan` (what the privileged helper will
refuse) and `crates/burrow-core` (reconciling the ledger against a real plugin
folder). Both are free of Tauri so they run on every platform in CI, including the
Windows paths that cannot be exercised by hand on a Mac.

To point the reconciliation logic at your own machine without a GUI:

```bash
cargo run -p burrow-core --example scan -- path/to/catalog.json
```

It reads, and writes nothing.

## Licence

MIT — see [LICENSE](LICENSE).

<!-- attributions:start -->
<!-- attributions:end -->
