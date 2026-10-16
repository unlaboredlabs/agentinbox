# agentinbox-cli is now xaq-cli

agentinbox was renamed to **xaq**. Use:

```sh
npx xaq-cli …        # was: npx agentinbox-cli …
xaq …                # was: agentinbox … (after npm i -g xaq-cli)
```

This package is a shim: `agentinbox …` prints that notice and runs `xaq-cli` with the same arguments, so
existing commands, scripts and services keep working.

Moving an existing install over (your data directory, keys and Hermes names are kept):
[Upgrading from agentinbox](https://github.com/wynn-dev/xaq#upgrading-from-agentinbox).
