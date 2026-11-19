# Dim

T3 Code can drive your existing Dim installation directly, over Dim's own App Server protocol. The
threads share Dim's home and its sessions with the `dima` terminal app: work started in either place
can be picked up in the other.

## Set Up Dim

1. Install Dim on the machine running the T3 Code server, so `dima` runs there.
2. Complete Dim's setup in a terminal, including signing in and configuring a model provider.
3. Open T3 Code Settings, choose **Settings → Providers → Add provider → Dim**, and confirm.

Dim and DimCode Alpha are separate entries: DimCode Alpha runs Dim through ACP, while Dim is the
native provider. Both read the same Dim installation and subscription.

## Settings

An added Dim instance has two settings beyond its binary path:

- **Dim home** is the Dim installation data T3 Code shares with the `dima` app. Leave it empty to use
  `DIMCODE_HOME`, or Dim's default `~/.dimcode-alpha`.
- **Socket override** connects to a daemon that is already running at that socket. When it is set,
  T3 Code never starts a daemon itself.

## Permission Modes

Dim offers two modes in the composer:

- **Auto-accept edits** lets Dim read and change files in the workspace without asking, but commands
  and other tools still need your approval.
- **Full access** lets Dim run without approval prompts.

Dim has no automatic reviewer, so T3 Code does not offer **Auto**.

## Sessions

T3 Code works on Dim's own sessions. Removing a thread in T3 Code does not delete its Dim session;
the session remains available in `dima` and can be imported again.

To import sessions you already have, open the Dim provider in **Settings → Providers**, choose the
project, and list its **Native sessions**. **Import** beside a session copies its history into a new
thread that continues the same conversation.

Dim has no way to truncate a conversation, so T3 Code does not offer rollback on Dim threads. To
return to an earlier point, fork the thread at the turn you want, or start a new thread.

## Troubleshooting

- If Dim is unavailable, confirm that `dima` runs on the server machine, then refresh the provider.
- If the daemon does not start, its log is at `daemon.log` inside Dim's `rust` directory under the
  configured Dim home.
