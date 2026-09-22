# Vercel Sandbox Box Mount contract review

This project ports the [Box Mount contract-review demo](https://github.com/box-community/boxmount-contract-review) from E2B to [Vercel Sandbox](https://vercel.com/docs/sandbox). The reviewer runs through [Vercel AI Gateway](https://vercel.com/docs/ai-gateway), so it needs no direct OpenAI key and no Box AI entitlement. Box Mount synchronizes the synthetic contract and playbook into the sandbox workspace and writes the generated review back to Box.

Box Mount's [recommended two-user split](https://developer.box.com/guides/box-mount/#recommended-setup-on-an-agent-sandbox) is enforced with [Sandbox users and groups](https://vercel.com/docs/sandbox/concepts/multi-agent): the sync process holds the Box credentials, and the agent user can reach only the mounted workspace.

## Prerequisites

- Node.js 20+
- A Vercel project with Sandbox access, and either a token, team and project ID or a project OIDC token
- An AI Gateway API key
- A new, empty Box folder and its folder ID
- A Box Developer Token with file read/write access
- The Linux x86_64 Box Mount archive

Developer Tokens expire after approximately 60 minutes and are for demo use only.

## Setup

```bash
npm install
cp .env.vercel.example .env
```

Fill in `.env`. The Vercel template already sets `SANDBOX_PROVIDER=vercel`.

```dotenv
SANDBOX_PROVIDER=vercel
VERCEL_TOKEN=your-vercel-token
VERCEL_TEAM_ID=your-team-id
VERCEL_PROJECT_ID=your-project-id
AI_GATEWAY_API_KEY=your-gateway-key
BOX_ACCESS_TOKEN=your-box-developer-token
BOX_FOLDER_ID=your-empty-box-folder-id
BOX_MOUNT_ARCHIVE=/absolute/path/box-mount-0.5.0-linux-x86_64.tar.gz
BOX_REVIEWER_USER_ID=
```

`AI_GATEWAY_MODEL` defaults to `openai/gpt-5.5`. Leave `BOX_REVIEWER_USER_ID` blank to skip Box task assignment. See the [Vercel setup guide](docs/vercel-setup.md) for preview access, OIDC authentication and recovery instructions.

The original E2B path still works. Set `SANDBOX_PROVIDER=e2b` and use `.env.example` instead.

## Run

```bash
npm run doctor
npm run seed
npm run demo
npm run status
npm run teardown
```

`doctor` checks the setup, including that the agent user cannot read the Box credentials. `seed` uploads the synthetic contract and playbook into the Box workspace. `demo` runs the reviewer in a Vercel Sandbox through AI Gateway and saves `Reviewed/Acme-MSA-review.md` in Box, leaving the session running for inspection. `status` reports on that session.

Run `teardown` before the 30-minute session deadline. It completes the final sync and unmount, verifies the review in Box, stops the session, deletes its record and checks the Box output again. If sync or unmount fails, follow the recovery guide before stopping the sandbox.

## Verification

The Vercel and AI Gateway path passed live `doctor`, `seed`, `demo`, `status`, `teardown` and a repeated `teardown`. The compatibility probe also confirmed a later Box-side edit reaching the same running sandbox. Typechecking and 27 unit tests passed.

See the [setup guide's verification commands](docs/vercel-setup.md#verification) and the [compatibility probe](docs/vercel-compatibility.md) to reproduce the checks. The direct OpenAI path, Box AI success and OIDC authentication were not exercised in that run.

The fixtures are synthetic and the generated memo is not legal advice. Box Mount is a private-preview binary and is intentionally not committed.
