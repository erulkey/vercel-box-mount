# Contract review on Vercel Sandbox

Set `SANDBOX_PROVIDER=vercel` to run the existing commands on Vercel Sandbox.
The Vercel workflow reuses Box's synthetic fixtures and
Box AI review function, plus its optional OpenAI runner.

## Setup

1. Obtain the Box Mount preview build and read [Box's setup guide](https://developer.box.com/guides/box-mount).
   This example currently checks the vendor SHA-256 of the 0.5.0 Linux x86_64
   archive. Keep the archive outside git. Other builds need a new compatibility
   check before changing the accepted checksum.
2. Create a dedicated empty Box folder. Configure an app with file read/write
   access and generate a developer token. For Box AI, also configure its required
   scope and confirm account access. Developer tokens expire after 60 minutes.
3. Copy `.env.vercel.example` to `.env`, or use a private file outside the repository:

```sh
export BOXMOUNT_ENV_FILE=/absolute/private/path/box-test.env
npm ci
npm run doctor
npm run seed
npm run demo
npm run status
npm run teardown
```

Example settings (fill values locally):

```dotenv
SANDBOX_PROVIDER=vercel
BOX_ACCESS_TOKEN=
BOX_FOLDER_ID=
BOX_MOUNT_ARCHIVE=/absolute/private/path/box-mount-0.5.0-linux-x86_64.tar.gz
VERCEL_TOKEN=
VERCEL_TEAM_ID=
VERCEL_PROJECT_ID=
BOX_REVIEWER_USER_ID=
```

Vercel project OIDC authentication is also supported instead of the explicit
three credentials. Supply `VERCEL_OIDC_TOKEN` from the intended project. Saved
recovery state binds subsequent operations to the original project/team.
Environment variables take precedence over the selected file. The live checks used
explicit token/team/project credentials; the OIDC path has source verification
but has not been exercised live.

To use Vercel AI Gateway, set `AI_GATEWAY_API_KEY` and optionally
`AI_GATEWAY_MODEL` (default `openai/gpt-5.5`). The Vercel workflow reuses the
existing OpenAI Responses reviewer with Gateway's endpoint. Gateway credentials
take precedence over `OPENAI_API_KEY`; a Gateway request failure does not switch
to direct OpenAI. The Gateway key is passed only to the agent's review command.
This path requires no direct OpenAI key or Box AI entitlement. A valid Box token
is still required for document sync. See [Gateway authentication](https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys).

Leave reviewer assignment blank. Box AI runs through the Box API; the optional
OpenAI reviewer runs inside the sandbox when `OPENAI_API_KEY` is set. Its model
is selected by `OPENAI_MODEL`, following the original example. A Box AI
`403 insufficient_scope` requires correcting the app scope and obtaining a token
with that permission. It does not establish a problem with filesystem sync.

## Lifecycle and credentials

The daemon runs as `boxmount`; the agent runs as `boxagent`, without sudo or Box
credentials. Only the shared workspace is accessible to both. Doctor verifies
that the agent cannot read the daemon's config. The ACL package is installed in
the sandbox and default ACLs preserve shared file access. SDK uploads are staged
in the agent home and copied into the mount with ordinary filesystem operations.
Before unmount, the trusted controller removes sticky flags from shared
subdirectories so the daemon can remove synced agent-owned files during reset.
This handles a permission failure observed in the tested multi-user workflow.

The sandbox is non-persistent with a 30-minute session deadline. Seed unmounts
and verifies fixture hashes in Box before stopping/deleting compute. Demo leaves
a successful review session running for inspection. Run teardown before expiry.
Teardown performs final sync/unmount, verifies Box output hashes, stops the
session, deletes its record, and verifies the files again. Stop and deletion are
separate operations. No snapshots or Drives are created.

A failed sync/unmount preserves recovery state and keeps compute available while
its deadline permits. Refresh expired credentials before recovery. Do not delete
state or stop compute containing unsynced work. Default state is
`.vercel-demo-state.json`; `BOXMOUNT_STATE_PATH` selects a private external path.
State and change receipts are retained after completion. Status uses
`resume: false` and issues no commands against a stopped session.

The current preview does not preserve Box version history for atomic-save file
replacements. Follow Box's documented limitations when extending the agent.

## Verification

```sh
npm test
npm run test:unit
npm run test:compatibility -- --evidence-dir /absolute/private/path/new-sync-run
BOXMOUNT_EXPECT_REVIEW_PROVIDER="AI Gateway" npm run test:e2e -- --evidence-dir /absolute/private/path/new-demo-run
```

The e2e command above requires an AI Gateway key and asserts that Gateway
generated the synchronized review. Use `OpenAI` or `Box AI` as the expected
provider when testing those paths.

The compatibility and e2e harnesses create uniquely named synthetic subfolders
under the configured Box folder. Keep the evidence parent outside the repository.
The compatibility probe additionally requires `BOX_MOUNT_SETUP_DOCS`, pointing
to a local capture of the preview guide. E2E runs the actual CLI commands and
requires generated-review hash verification after cleanup. The token must remain
valid for the entire run. See [compatibility details](vercel-compatibility.md).
