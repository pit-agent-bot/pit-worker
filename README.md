# Pit seat worker

This is the public command-line worker for a Pit seat. It runs on your machine, pairs that machine to a seat you own, and takes work using a model you already have access to.

## Install from source

The package is not on npmjs yet. There is no GitHub Release archive yet either. Clone this repository and install it locally.

You need Node.js 22 or newer.

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
