---
layout: nubisco
title: 'The MCP endpoint'
intro: 'OpenBridge speaks the Model Context Protocol at `/mcp`, so you can ask Claude, or any MCP client, about your devices and get answers from the readings and history your bridge already records.'
---

## What it is for

Everything your plugins report passes through OpenBridge: power and energy,
temperatures, what opened and when, what the logs said. The MCP endpoint lets an
agent read all of it and, if you allow it, operate devices.

- "How much energy did the house use this week compared with last week?"
- "What was the lowest room temperature last night, and was the heat pump running?"
- "When did the gate last open, and what opened it?"
- "Why did the Tuya plugin restart this morning?"

The endpoint runs inside the daemon, on the same port as the dashboard
(`http://<your-bridge>:8582/mcp`). Nothing leaves your network unless you put
the bridge on the internet yourself.

## Turn it on

The endpoint is **off by default**. An agent that can read and operate a home is
something you decide to allow, so no install or update turns it on for you.
While it is off, `/mcp`, the sign-in routes and token management do not exist.

Set `OPENBRIDGE_MCP=on` in the daemon's environment and restart it:

```sh
OPENBRIDGE_MCP=on openbridge            # run directly
```

```yaml
# docker-compose.yml
services:
  openbridge:
    environment:
      OPENBRIDGE_MCP: 'on'
```

For a systemd service, add `Environment=OPENBRIDGE_MCP=on` to the unit. Settings
→ AI agents shows whether it is on.

## Connect Claude Code

1. In the dashboard, open **Settings → AI agents** and choose **New token**.
   Read only is the default. Choose **Read and control** only if the agent
   should be able to operate devices.
2. Copy the command shown with the token and run it:

```sh
claude mcp add --transport http openbridge http://192.168.1.10:8582/mcp \
  --header "Authorization: Bearer obt_pat_..."
```

The token is shown once. OpenBridge stores only a hash of it.

### No dashboard sign-in? Use the host

On the machine running OpenBridge:

```sh
openbridge token create "Claude on my laptop"            # read only
openbridge token create "Home assistant agent" --control  # read and control
openbridge token list
openbridge token revoke <id>
```

The running daemon picks the change up without a restart. Whoever has a shell
on the host already owns the bridge, so the command asks for nothing else.

## Connect without a token

Clients that sign in instead of taking a pasted header (Claude Code's own
OAuth flow, the claude.ai custom connector, ChatGPT) can add the endpoint and
nothing else. OpenBridge is its own
authorization server: the client registers itself, opens a consent screen on
your bridge, and you approve it there, choosing read only or read and control.
Access tokens last an hour and refresh themselves. Approved applications are
listed under **Settings → AI agents → Connected applications**, and
disconnecting one cuts all of its sign-ins at once.

In Claude Code, add the endpoint, then run `/mcp`, pick `openbridge` and
choose to authenticate. Your browser opens the consent screen:

```sh
claude mcp add --transport http openbridge http://192.168.1.10:8582/mcp
```

### claude.ai and the Claude app

Custom connectors in claude.ai, and in the Claude desktop and mobile apps that
share them, connect from Anthropic's cloud, not from your computer. They can
only reach a bridge on a public `https://` address, so a bridge that is only on
your home network needs a tunnel or a reverse proxy first (see below). Then, in
**Settings → Connectors → Add custom connector**, give it
`https://<public-address>/mcp` and leave the OAuth client fields empty.

A connector that cannot reach the bridge, or that is handed `http://`
addresses, fails with "Couldn't register with OpenBridge's sign-in service".
Check that `https://<public-address>/.well-known/oauth-authorization-server`
opens from outside your network and lists only `https://` addresses.

The connector list shows the icon of the address's domain, not OpenBridge's
logo, and nothing on the bridge changes that.

A tunnel (Cloudflare Tunnel, for example) or a reverse proxy that ends HTTPS in
front of the bridge works as is: the bridge reads `X-Forwarded-Proto` and hands
out `https://` sign-in addresses on the public hostname, while clients on your
network keep the address they used. Set `OPENBRIDGE_PUBLIC_URL` (for example
`https://bridge.example.com`) only when your proxy does not send that header or
rewrites the host, because it then applies to every client.

Putting the bridge on the internet puts the whole dashboard there, not only
`/mcp`, and that includes the shell pane. **Turn dashboard sign-in on first.**
If your tunnel can route by path, publishing only `/mcp`, `/oauth/`,
`/.well-known/`, `/auth/` and the dashboard's static files is narrower still:
that is all a connector and the consent screen use.

## Who can connect

**A token is always required at `/mcp`**, even when dashboard sign-in is off and
the rest of the API is open on your network. An agent that can move physical
things should never reach an endpoint that asks nothing.

Two levels of access, and nothing else:

| Access           | Can                                                                    |
| ---------------- | ---------------------------------------------------------------------- |
| Read only        | Devices, current readings, health, history, events, observations, logs |
| Read and control | All of that, and run device controls and HomeKit characteristic writes |

A token opens `/mcp` and nothing else: it cannot reach the REST API, mint
another token, revoke one, change configuration, install plugins, open the
shell or apply updates. Those stay behind the dashboard.

**Who may create tokens and approve connections** is whoever may use the
dashboard. With sign-in on, that is a signed-in person. With sign-in off, the
dashboard is open to your network, and so is creating a token. Creating a token
and approving a connection are refused when the request comes from a page that
is not the bridge's own dashboard, so a website you visit cannot do it for you.

This works with any sign-in setup, or none. MCP tokens are issued and checked
by the bridge itself and do not depend on the platform sign-in.

## Tools

| Tool                  | Access  | What it does                                                                                                                                    |
| --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `overview`            | read    | Start here: the bridge, plugins, every device with current telemetry, health, metrics and controls, and Homebridge accessories with their state |
| `device_get`          | read    | One device in full: descriptor, telemetry, metrics with units, controls, actions, recent events                                                 |
| `device_history`      | read    | One metric over a window (`last: "7d"` or `from`/`to`), with the summary already computed: first, last, min, max, and mean or amount used       |
| `device_events`       | read    | What happened to a device and what caused it                                                                                                    |
| `device_observations` | read    | What people reported about a room the device controls                                                                                           |
| `logs`                | read    | Recent daemon and plugin logs, filtered by plugin, level, text and time                                                                         |
| `device_control`      | control | Up to 100 ops: plugin controls and HomeKit characteristic writes, each answered on its own                                                      |

`device_history` returns its summary computed by the bridge, so the agent quotes
numbers rather than doing arithmetic over raw points. The bridge keeps 10-second
detail for 48 hours, 1-minute for 30 days, 5-minute for a year and hourly for
five years.

Every `device_control` op carries an `op_id`. Sending the same `op_id` again
returns the first answer without running the op twice, so a retry after a
timeout never presses the gate button a second time. A control the plugin marked
as restricted is refused here as it is in the dashboard.

## How it is built

Stateless Streamable HTTP: every request is one JSON-RPC message over `POST`,
answered with JSON. No sessions, no server-sent events, tools only. The tools
call the same functions as the REST API, so an agent can never do more than the
same request through the API. Tokens and connections live in
`~/.openbridge/access.json`, hashed, with file mode 600.
