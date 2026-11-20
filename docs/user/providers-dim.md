# Dim

T3 Code can drive your existing Dim installation directly, over Dim's own App Server protocol. The
threads share Dim's home and its sessions with the `dima` terminal app: work started in either place
can be picked up in the other.

## Set Up Dim

1. Open **Settings → Providers → Add provider → Dim** and choose the server that will run it.
2. If Pina Code offers **Install Dim**, use it to install the CLI on that server. You can also run
   `npm install -g dimcode-alpha@alpha` on the server yourself.
3. Select **Sign in**, open the verification page, and enter the displayed device code. Once Dim
   confirms sign-in, Pina Code refreshes the model list and subscription usage.

Dim shares its account with the `dima` CLI. Use **Sign out** in the same provider settings to sign out
of that Dim home. Subscription credits and token windows appear under **Usage → Limits**.

On upgrade, DimCode Alpha and the Registry edition move to Dim and keep their Pina Code chat
history. The Registry edition uses a separate session store. Sign in to Dima if needed, then continue
the thread using the saved chat context. The old sessions remain available in the stable CLI.

## Settings

An added Dim instance has two settings beyond its binary path:

- **Dim home** is the Dim installation data T3 Code shares with the `dima` app. Leave it empty to use
  `DIMCODE_HOME`, or Dim's default `~/.dimcode-alpha`.
- **Socket override** connects to a daemon that is already running at that socket. When it is set,
  T3 Code never starts a daemon itself.

## Permission Modes

Choose a permission mode in the composer.

- **Approval required** uses Dim's read-only preset.

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
