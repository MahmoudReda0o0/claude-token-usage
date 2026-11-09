# token-usage

A Claude Code mod that shows how many tokens you use: in this conversation, across all conversations on this device, on each of your devices, and against your account's rate limits.

## What it shows

- **Status line**: `🪙 this chat … · all … · 5h …%`
- **A "Token usage" pane** beside the chat:
  - **This conversation**: total tokens and cost, split into input, output, cache read, cache write and turns.
  - **This device, all conversations**: totals over every conversation recorded here (the last 300 are kept).
  - Three dropdowns, opened by pressing the header or its hotkey:
    1. **Account limits (all devices)**: the account's 5-hour and 7-day rate-limit percentages, with a bar and the reset time.
    2. **Devices**: this device plus every other device running the mod, synced through a private GitHub Gist. Without sync set up it shows this device only and "Sync is off".
    3. **Recent conversations on this device**.
- **`/tokens`**: opens the pane and prints a short summary.

Usage is counted from every model turn (subagents included); cost comes from the session's own cost figure.

## Syncing devices (optional)

To see all your devices in one list:

1. Go to <https://gist.github.com>, create a **secret** Gist with any file (for example `sync.json` holding `{}`), and copy its ID: the last part of its URL.
2. Create a GitHub token with **only the `gist` scope** (Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token, tick `gist`).
3. When you install the mod on each device, enter the same **Sync Gist ID** and **GitHub token**, and a **Device name** (e.g. `Laptop`, `Office PC`) for that device.

Each device writes its totals to the Gist about once a minute and reads the others'. The token is stored as a secret option and never written to the Gist.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install token-usage --marketplace MahmoudReda0o0/claude-token-usage
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). Then fill in the options, or leave them empty for this device only.

From a shell:

```
claude plugin install token-usage --marketplace MahmoudReda0o0/claude-token-usage
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `MahmoudReda0o0/claude-token-usage`, then **Add plugin**.

If the repository is private, each device needs a git credential for github.com first: run `gh auth login`, then `gh auth setup-git`.

## License

MIT
