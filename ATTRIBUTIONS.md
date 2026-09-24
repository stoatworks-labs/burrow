# Attributions

Stoatworks Burrow is built on other people's work. This file lists what that work is,
who did it, and what it is doing here.

The component descriptions come from the master lists in the `stoatworks-backend` repo
(`attributions/components.json`). Burrow is not yet wired into
`scripts/sync-attributions.py`, so this copy is maintained by hand until it is —
add it there rather than editing the prose here.

## Third-party code this project uses

Libraries, SDKs and frameworks the project is built on or bundles.

### Tauri

<https://tauri.app>  
Licence: MIT or Apache-2.0  
Copyright: The Tauri Programme within The Commons Conservancy

A Cargo and npm dependency.

Puts a web front end on a native Rust core using the platform's own webview, so the binary stays small and the DSP stays in Rust.

### React

<https://react.dev>  
Licence: MIT  
Copyright: Meta Platforms, Inc. and affiliates

An npm dependency.

The UI layer for the browser tools and the Electron and Tauri front ends.

### The Rust crate ecosystem

<https://crates.io>  
Licence: predominantly MIT or Apache-2.0  
Copyright: the individual crate authors

Cargo dependencies, resolved and pinned in Cargo.lock.

Async runtimes, protocol codecs, serialisation and GUI toolkits. The exact set and versions for any build are in that repo's Cargo.lock, which is the authoritative list.

### The npm ecosystem

<https://www.npmjs.com>  
Licence: predominantly MIT  
Copyright: the individual package authors

npm dependencies, resolved and pinned in the lockfile.

Build tooling, test runners and the libraries the front ends are assembled from. The exact set and versions for any build are in that repo's lockfile, which is the authoritative list.

## Work this project reads from, but does not include

### The OpenFX plug-in search path

<https://github.com/AcademySoftwareFoundation/openfx>  
Licence: BSD-3-Clause  
Copyright: OpenFX and contributors to the OpenFX project

Burrow vendors no OpenFX code. It does rely on the directories the reference host
implementation searches — `/Library/OFX/Plugins` on macOS and
`Common Files\OFX\Plugins` on Windows — which is why installing an OpenFX plugin
needs an administrator password. That behaviour was read out of
`HostSupport/src/ofxhPluginCache.cpp` rather than assumed.

### The plugins themselves

Burrow installs the Stoatworks video plugins and ships each one's browser demo, but
contains none of their code. Each plugin carries its own licence and its own
attributions in its own repository.

## Getting this wrong

If something here is miscredited, mislicensed or missing, that is a bug — please
[open an issue](https://github.com/stoatworks-labs/burrow/issues) and it will be fixed.
