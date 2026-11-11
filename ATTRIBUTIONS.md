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

### espflash

<https://github.com/esp-rs/espflash>  
Licence: MIT or Apache-2.0  
Copyright: the esp-rs contributors

A Cargo dependency, without its command-line half.

Speaks the ESP32 serial protocol for the Device firmware tab: the USB-Serial-JTAG reset, the stub loader, flash writes and the MD5 checks. Burrow decides what may be written; espflash writes it.

### serialport-rs

<https://github.com/serialport/serialport-rs>  
Licence: MPL-2.0  
Copyright: the serialport-rs contributors

A Cargo dependency, used unmodified; its source is on crates.io.

Lists and opens the serial port a CANary appears on.

### nusb

<https://github.com/kevinmehall/nusb>  
Licence: MIT or Apache-2.0  
Copyright: Kevin Mehall and contributors

A Cargo dependency.

Pure-Rust USB, for a BirdDog PLAY in Rockchip recovery mode: the maskrom control transfers and the loader's bulk endpoints. No libusb to bundle or sign.

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

### rkdeveloptool

<https://github.com/rockchip-linux/rkdeveloptool>  
Licence: GPL-2.0  
Copyright: Fuzhou Rockchip Electronics Co., Ltd

No code from it is included. The Rockchip USB protocol constants Burrow uses (the
maskrom vendor request, the CBW opcodes, the padding rules, the GPT built from
`parameter.txt`) were read out of its source by the browser PLAY Flasher, and Burrow's
Rust is a port of that flasher's own code.

### The CANary Flasher, PLAY Flasher and PLAY Patcher

<https://github.com/stoatworks-labs/canary-flasher>  
<https://github.com/stoatworks-labs/birddog-play-flasher>  
<https://github.com/stoatworks-labs/birddog-play-patcher>  
Licence: MIT  
Copyright: Allan Sargeant

The Device firmware tab is a port of these three browser tools into Rust: their
checks, their image and partition handling, and their package format, kept byte for
byte compatible and tested against them.

### What a PLAY package carries

Burrow ships none of it. When you build a package, it fetches Tailscale (BSD-3-Clause,
from `pkgs.tailscale.com`) and MediaMTX (MIT, from its GitHub release), and packs them
with the patcher kit's own binaries, whose licences and source offer travel in the kit's
`NOTICES/`. BirdDog's factory image and its loader are only ever your own copy, and
BirdDog is a trademark of its owner; Burrow is not affiliated with them.

### The plugins themselves

Burrow installs the Stoatworks video plugins and ships each one's browser demo, but
contains none of their code. Each plugin carries its own licence and its own
attributions in its own repository.

## Getting this wrong

If something here is miscredited, mislicensed or missing, that is a bug — please
[open an issue](https://github.com/stoatworks-labs/burrow/issues) and it will be fixed.
