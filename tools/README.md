# `tools/` — the native-messaging install

Everything in this directory exists so that `local` mode can pair **without a
human pasting a pairing string**: Chrome asks a small host process for a
one-time ticket, hands it to the extension, and the extension dials the relay.

    tools/
      install-native-host.mjs         the installer / checker / uninstaller
      native-host/relay-host.mjs      the host Chrome runs (stdlib only)

## Install

    node tools/install-native-host.mjs              # chrome + chromium, per-user
    node tools/install-native-host.mjs --print      # dry run: show the whole plan
    node tools/install-native-host.mjs --check      # verify; exit 1 on any drift
    node tools/install-native-host.mjs --uninstall  # remove everything it wrote

    # or through npm
    npm run native-host:install | native-host:check | native-host:uninstall

Flags, for the cases the defaults do not cover:

| flag | why you would use it |
| --- | --- |
| `--extension-dir <path>` | install for a different unpacked tree (default `../extension`) |
| `--extension-id <id>` | pin the id instead of deriving it from the path |
| `--host-script <path>` | launch a different host — e.g. the transport checkout's `relay/native-host.ts` |
| `--node <path>` | launch a different node runtime (default: the one running the installer) |
| `--appdata <path>` | stage an install somewhere other than the real `%LOCALAPPDATA%` |
| `--browsers chrome,chromium` | which browser families get the registry value |
| `--json` | machine-readable output |

It is idempotent, needs no elevation, and touches only:

    %LOCALAPPDATA%\hermes\native-messaging\com.hermes.browser_relay.json
    %LOCALAPPDATA%\hermes\native-messaging\com.hermes.browser_relay.bat
    %LOCALAPPDATA%\hermes\native-messaging\installed.json      (what it wrote)
    %LOCALAPPDATA%\hermes\logs\com.hermes.browser_relay.log
    HKCU\Software\Google\Chrome\NativeMessagingHosts\com.hermes.browser_relay
    HKCU\Software\Chromium\NativeMessagingHosts\com.hermes.browser_relay

`--uninstall` removes the two registry values (and the `NativeMessagingHosts`
container if it is left empty), the manifest, the launcher and the state file.

## Two things that are easy to get wrong

**The extension id.** Chrome derives an unpacked extension's id itself: SHA-256
of the *absolute extension path* (native separators, UTF-16LE), first 16 bytes,
each nibble mapped to `a`–`p`. `allowed_origins` has to carry exactly that, which
is why the installer computes it rather than asking you to copy it out of
`chrome://extensions`. `npm run test:relay:native` asserts the computed value
equals the live `chrome.runtime.id`, so the derivation cannot silently drift.

**The launcher.** Chrome cannot start `node.exe` *with a script argument* from a
native-messaging manifest — the format has no `args` field. So the installer
writes a `.bat` launcher, exactly the shape Google's own native-messaging
example installs, and Chrome starts it through `cmd.exe /c`. Two consequences
the installer has to get right, and does:

* `@echo off`, because anything the launcher prints to stdout would corrupt the
  framed message stream;
* absolute paths for `node.exe` and the host script, so nothing depends on
  `PATH`, the working directory or shell expansion.

Chrome throws a native host's stderr away, so the launcher redirects to
`com.hermes.browser_relay.log`, and `relay-host.mjs` appends its own diagnostics
there too (`HERMES_NATIVE_LOG` overrides the location). Ticket values are
redacted before they can reach it.

## The host

`native-host/relay-host.mjs` is a vendored, dependency-free copy of the transport
workstream's `relay/native-host.ts`: it POSTs `/browser/pair`, writes exactly one
framed `pair.response`, and exits. It is vendored so the *installed* host cannot
break when a git checkout moves or an npm tree is pruned; `npm test` runs both
hosts side by side against a stub relay and asserts the replies are identical.

Relay discovery order: `HERMES_RELAY_URL` → `HERMES_RELAY_RENDEZVOUS` →
`HERMES_RELAY_URL_FILE` → `%LOCALAPPDATA%\hermes\browser-relay.json` → the
default loopback port (`47317`).

One deliberate difference from the original: if stdin reaches EOF while a pairing
request is still in flight, this copy still answers instead of exiting silently.
