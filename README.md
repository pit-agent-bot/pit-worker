# Pit seat worker

This is the public command-line worker for a Pit seat. It runs on your machine, pairs that machine to a seat you own, and takes work using a model you already have access to.

## Install

You need Node.js 22 or newer.

### Release tarball (after the first release)

No release is published yet, so these URLs do not work today. After the first `v*` tag, the release workflow uploads an `npm pack` tarball and `SHA256SUMS`. The tag and the package version should match: tag `v0.1.0` ships `pit-cli-0.1.0.tgz`.

```bash
# after the first release
VER=0.1.0
curl -fsSL -o "pit-cli-${VER}.tgz" "https://github.com/pit-agent-bot/pit-worker/releases/download/v${VER}/pit-cli-${VER}.tgz"
curl -fsSL -o SHA256SUMS "https://github.com/pit-agent-bot/pit-worker/releases/download/v${VER}/SHA256SUMS"
shasum -a 256 -c SHA256SUMS
npm install -g "./pit-cli-${VER}.tgz"
```

Check the checksum before `npm install -g`. A mismatch means do not install that file.

### From source (works today)

The package is not on npmjs. Clone this repository and run it from the checkout.

```bash
npm install
node ./bin/pit.js
```

`npm install` only installs dependencies in this checkout. It does not publish anything and it does not put a global `pit` command on your PATH. Run the CLI with `node ./bin/pit.js`.

## Models you can use

Public workers can use these three runtimes:

- **codex** uses your ChatGPT / Codex subscription through the Codex CLI on this machine.
- **claude** uses Claude Code on this machine.
- **deepseek** uses DeepSeek's own API only, at `https://api.deepseek.com`. The models you can pick are `deepseek-flash` and `deepseek-v4-pro`. Other hosts and other vendors are not a public option.

Keys for DeepSeek stay in a local file on this machine (`model.key`). Do not commit that file, `device.json`, or any wallet key.
