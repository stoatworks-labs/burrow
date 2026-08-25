# Stoatworks Burrow user guide

**Burrow installs, updates and removes the Stoatworks video plugins.** One list,
one click each, and it knows where every format goes on your machine.

> **Status at v0.1.1 — read this first.**
>
> Burrow has been tested thoroughly against real plugin downloads, but **no plugin
> has yet been installed into a running Resolume, Resolve or After Effects through
> it**. If you are about to use it before a show, don't. Try it on a machine where
> a broken plugin folder would cost you nothing.
>
> On Windows it can install FFGL plugins for Resolume, but not OpenFX or After
> Effects plugins — that part is not written yet, and it says so rather than
> half-working.
>
> This is an AI-assisted project, directed and reviewed by a human author.

---

## Installing Burrow

Download it from [the project page](https://stoatworks-labs.com/software/burrow/),
open the disk image and drag Burrow to your Applications folder. On Windows, run
the installer.

Burrow is not required for anything. Every plugin can still be downloaded and
installed by hand, exactly as before — Burrow only saves you doing it.

## The first thing you'll see

Burrow reads your plugin folders and shows you what you already have. It does not
change anything until you tell it to.

Three headings:

- **Up to date** — you have it, and it's current.
- **Update available** — you have it, and there's a newer version.
- **Not installed** — available, and you don't have it.

Each row shows which **formats** that plugin offers and what you have of each:

| What you see | What it means |
|---|---|
| `FFGL ✓ 1.0.2` | Installed, current |
| `FFGL 1.0.1 → 1.0.2` | Installed, and there's an update |
| `OpenFX +` | Available, not installed. Click it to install just that one |
| `OpenFX + · admin` | Same, but it will ask for your password |
| `FFGL ✓ version unknown` | It's installed, but nothing on disk says which version |
| `Adobe —` | No build of this plugin for that host |

**"Version unknown" is not a fault.** On Windows a plugin is a bare `.dll` with no
version in it, so Burrow genuinely cannot tell — it will offer to reinstall the
current version rather than pretend to know. It also happens on macOS if you built
a plugin yourself, or installed one before you had Burrow.

## Keeping it current

Two buttons, above the list, because they do different jobs:

**Rescan installed** re-reads your plugin folders. It uses no network at all, so
it works offline and is instant. Press it after installing or removing a plugin
by hand — Burrow will notice without being told twice.

**Check for updates** fetches the plugin list. This is the one that finds new
versions and new release notes, and the only one that goes anywhere.

Both say what they actually did — *"2 new versions · 1 now needs updating"*, or
*"Nothing changed"* — and each shows when it last ran. If the version numbers
you are looking at came from the copy that shipped with the app rather than a
live check, the second button says **not checked** rather than a time.

## Watching a plugin before you install it

Every plugin's video is the picture at the left of its row. Click it and the
video opens in your own browser.

The still is part of the app rather than something fetched from YouTube — so the
list works offline, and browsing plugins in Burrow tells Google nothing. Nothing
is requested until you click.

## Formats, and which ones you want

Most plugins come in more than one format. They are the same effect; the format is
just which application loads it.

| Format | For |
|---|---|
| **FFGL** | Resolume Arena and Avenue |
| **OpenFX** | DaVinci Resolve, Vegas Pro, Nuke, Natron |
| **Adobe** | After Effects and Premiere Pro |

In **Settings**, tick the ones you use. Burrow starts with FFGL only, because
that's the one that needs no password.

You can override this for a single plugin from its row — **Formats…** — if there's
one you want in Resolve but not Resolume, or the other way round. A row with its
own choice shows a small **custom formats** label so you can see at a glance that
it isn't following your defaults.

## Why it asks for your password

FFGL plugins go into your own Documents folder, and Burrow never needs anything
special for those.

OpenFX and After Effects plugins are different. They go into folders that belong
to the system:

```
OpenFX     macOS    /Library/OFX/Plugins
           Windows  C:\Program Files\Common Files\OFX\Plugins
Adobe      macOS    /Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore
           Windows  C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore
```

There's no alternative: those are the only places those applications look. So
Burrow asks for an administrator password — **once**, however many plugins are in
the batch, and only when the batch actually needs it.

What happens behind that prompt is deliberately small. Burrow downloads,
unpacks and checks everything *first*, with no special rights at all. Only then
does it hand a separate helper program a list of files to move, and that helper
can do nothing else: it has no way to reach the network, no way to open an
archive, it will only write into the plugin folders above, and it will only delete
a file it has itself just moved aside seconds earlier.

**If you change your mind at the password prompt, nothing is lost.** Anything in
that batch that didn't need a password is already installed, and the rest is
reported as cancelled — not as an error.

## `/Library/OFX/Plugins` is empty, and that's normal

If you have DaVinci Resolve installed and Burrow tells you there are no OpenFX
plugins, nothing is wrong. Resolve builds its own effects into the application
rather than installing them as separate plugins, so that folder is usually empty —
and often doesn't exist at all — on a machine that uses Resolve every day.

Burrow will create it the first time you install an OpenFX plugin.

## After installing

**Restart the host.** Resolume, Resolve and After Effects all read their plugin
folders at startup. A plugin installed while they are running will not appear
until they are restarted — in Resolume you may also need to rescan effects.

If a plugin still doesn't appear, the likeliest cause on macOS is the quarantine
flag, which makes Resolume skip a plugin *silently* rather than telling you.
Burrow clears it on everything it installs, so this should not happen — but if it
does, that's worth [reporting](https://github.com/stoatworks-labs/burrow/issues).

## Trying a plugin before you install it

Press **Try demo** on any row. The plugin's browser demo opens in a window,
running the plugin's own shaders — no installation, and nothing sent anywhere.
Every demo is built into Burrow, so this works with no internet connection at all.

A few plugins have no demo: Cartridge needs an emulator core you supply yourself,
and Amber and nib are too new. Those rows have no **Try demo** button rather than
a button that does nothing.

## Uninstalling

**Uninstall** on any row removes exactly what Burrow installed, and nothing else.

Your plugin folder almost certainly contains other things — plugins from other
people, examples that came with an SDK, your own builds. Burrow does not look at
them, does not list them, and cannot remove them. It only ever touches files it
knows belong to a plugin in its own list.

If you installed a plugin by hand before you had Burrow, it can still remove it —
but it will tell you exactly which files it is going to delete first.

## What Burrow sends

There is no account, and no sign-in, because there is nothing to sign in to.

Burrow fetches one file — the plugin list from `stoatworks-labs.com` — and
downloads plugin archives from GitHub. That is all. It sends no identifier, no
list of what you have installed, and no usage data. The demos run from inside the
app and are blocked from making any network request at all.

The **Send feedback** button at the bottom of the window is the exception, and only
when you press it: it sends what you type, plus the version of Burrow.

## When it can't reach the internet

Burrow works offline. It ships with a copy of the plugin list, so it can still
show you everything and tell you what you have installed.

It will say so — a banner reading *"Showing the plugin list that came with this
app"* — because version numbers from a list written weeks ago are not the same
claim as version numbers checked a minute ago, and you should be able to tell
which you are looking at. Installing still works; the downloads come from GitHub.

## If something goes wrong

Errors appear on the row they belong to, with what actually failed, and stay there
until you do something about them. Nothing disappears into a notification you
might have looked away from.

A failed install leaves your plugin folder exactly as it was. Burrow never writes
into a live plugin file: it unpacks and checks everything somewhere else first,
and only swaps the finished result into place. If that swap fails partway through
a plugin with more than one component, it puts back the ones it had already done.

For anything else, [open an issue](https://github.com/stoatworks-labs/burrow/issues)
or use **Send feedback** in the app.
