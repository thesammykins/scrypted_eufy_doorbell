# Eufy Doorbell for Scrypted

A Scrypted plugin for Eufy battery doorbells. It signs in to your Eufy account, talks to the doorbell over P2P through your HomeBase, and exposes it to Scrypted as a normal doorbell, so HomeKit, Google Home and the Scrypted NVR work without the Eufy app.

Tested on a Video Doorbell Dual (T8213) behind a HomeBase 2 (T8010). Other Eufy cameras on the account are ignored.

## What it does

- Live view only while someone is watching. The doorbell is woken on demand and goes back to sleep when the last viewer leaves, so nothing streams in the background.
- The Video Doorbell Dual's two lenses are composed into one 2134x1200 view: the main lens at full resolution, with the package camera inset bottom-right. H.265 from the doorbell is re-encoded to H.264 for HomeKit and Google Home, on the GPU (NVENC) when the server has one.
- Doorbell presses, motion, and Eufy's own person, package, vehicle and pet detections arrive as Scrypted events.
- Two-way audio over P2P.
- Snapshots use the thumbnail Eufy attaches to each event, so tiles never wake the doorbell.
- Ring clips (and motion clips, if enabled) are copied off the HomeBase into Scrypted at full resolution and play in the Scrypted NVR event list. The doorbell is never woken for this; the clips come from the HomeBase's storage.
- Low-battery alerts to any Scrypted notifier.

## How it works

The Eufy protocol work is done by [@mega-yfue/eufy-sdk](https://github.com/mega-yfue/eufy-sdk), the successor to bropat's eufy-security-client. It needs Node 24.5 or newer, and Scrypted's Docker image runs Node 22, so the plugin downloads a pinned Node 24 build (checked against its SHA-256) into its own volume and runs eufy-sdk in a child process there. The plugin side handles Scrypted, ffmpeg and the media plumbing.

eufy-sdk 0.5.0 refuses HomeBase recording names with a codec prefix (`h265_20261125201147`), which is how battery doorbells store their clips. The plugin patches that one check when it installs the SDK and fails loudly if the pinned version ever changes.

## Install

This plugin is not on npm. Build it and deploy it to your Scrypted server from a clone:

```sh
git clone https://github.com/thesammykins/scrypted_eufy_doorbell.git
cd scrypted_eufy_doorbell
npm install
npx scrypted login <your-scrypted-host>
SCRYPTED_HOST=<your-scrypted-host> npm run deploy
```

Then open the plugin in Scrypted, enter your Eufy email, password and country, and type in the verification code Eufy sends. The session is saved, so restarts do not ask again. The plugin uses its own device identity, so your phone stays signed in to the Eufy app.

The first start downloads Node 24 (about 30 MB) and installs eufy-sdk, which takes a minute.

## Settings worth knowing

- **Eufy Notification Style** must be a thumbnail style for event snapshots and ring clips to work. On battery doorbells this has to be changed in the Eufy app (doorbell > Notifications).
- **Max Live View** caps how long the doorbell stays awake for one viewing session (default 300 seconds).
- **Archive Motion Clips** keeps motion clips as well as rings.
- **Keep Clips** sets how many days of clips to keep (default 30).

HomeKit Secure Video and Scrypted NVR recording both stream from the doorbell on every motion event, which costs battery. Use HomeKit's "Stream" mode if you only want live view.

## Development

```sh
npm run typecheck                         # plugin (Node 22) and worker (Node 24)
SCRYPTED_HOST=<host> npm run deploy
SCRYPTED_HOST=<host> npm run console      # plugin log
```

With mise, put `SCRYPTED_HOST` in a `mise.local.toml` (git-ignored) under `[env]`.

## License

MIT
