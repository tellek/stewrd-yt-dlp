# YT-DLP

A Stewrd plugin that wraps [yt-dlp](https://github.com/yt-dlp/yt-dlp) in a simple queue-based download UI.

## Features

- Paste a URL, press Enter or "Add To Queue" - the download starts automatically (one at a time).
- Live progress bar + ETA for the item currently downloading.
- Automatically downloads and installs yt-dlp and FFmpeg on first run (asks for confirmation first), and checks for yt-dlp updates on startup.
- Output folder is set directly in the plugin's pane.

## Settings

Most yt-dlp behavior is configured via **Settings > Plugins > Configure**, editing this plugin's `settings.json` directly. See the field-by-field notes in that file's comments-equivalent (the plan doc) for what each option maps to, but in short:

- `format` / `audioOnly` / `audioFormat` - what to download. Audio-only (mp3) is the default, both here and as the default choice in the Format dropdown in the plugin's UI.
- `outputTemplate` - yt-dlp's `-o` filename template (the output *folder* itself is set from the plugin's UI, not here).
- `embedThumbnail` / `embedMetadata` / `embedChapters` - post-processing polish (requires FFmpeg, installed automatically).
- `subtitles.*` / `sponsorBlock.*` - optional extras, off by default.
- `sleepIntervalMinSeconds` / `sleepIntervalMaxSeconds` - the main mitigation against YouTube's temporary rate-limiting/bans. By default each download waits a randomized 5-25 seconds (`--sleep-interval`/`--max-sleep-interval`) so requests don't look like a bot burst. Set both to `0` to disable.
- **Use Browser Cookies** button (in the plugin's UI, not settings.json) - opens your default browser to YouTube (so you can confirm you're logged in), detects which browser that was, and uses its cookies for every download for the rest of the current session. This is session-only by design (never written to settings.json or disk) - it resets on every app restart, so you'll need to press it again next time you want it.
- `extraArgs` - escape hatch for any yt-dlp flag not modeled above.

## Development

```sh
npm install
npm run build   # bundles index.tsx -> dist/index.js
npm test        # vitest
```

Run `build-release.bat` to deploy a built copy into a local Stewrd install's `plugins/` folder for manual testing.
