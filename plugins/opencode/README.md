# VACP for OpenCode

Download the versioned OpenCode package from the VACP Agent page. Extract the archive and add its package directory to OpenCode's configuration. V2 uses the `plugins` array in `opencode.jsonc`. V1.18.29 and newer use the `plugin` array. Use a local directory, for example:

```json
{ "plugins": ["./plugins/vacp-opencode"] }
```

Set `VACP_URL`, `VACP_WORKSPACE_ID` and `VACP_PLUGIN_ACCOUNT_TOKEN` in the OpenCode server environment to enable the `vacp_plugin_catalog` tool. The token belongs in the environment, outside the project and tool inputs. Local development defaults to `http://127.0.0.1:5176`.

The package also contains a terminal client. Run `node cli.js workspaces`, `node cli.js list` or `node cli.js download opencode 0.1.0` from the extracted package directory. It accepts the same environment variables or asks for your VACP email and password in an interactive terminal. A download verifies the archive against the catalog SHA-256 and saves it to the current directory.
