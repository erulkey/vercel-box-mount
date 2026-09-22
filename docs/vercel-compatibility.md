# Vercel compatibility probe

Install the locked dependencies with `npm ci`. The probes pin `@vercel/sandbox`
to 3.2.2. Supply a Vercel project development OIDC token, or all three of
`VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`. Set `BOXMOUNT_ENV_FILE`
to load a private local environment file; existing process variables take
precedence. Keep credentials, preview binaries and raw evidence outside git.

Choose a new evidence directory under an existing private parent outside the
repository for every run:

```sh
npm run test:runtime -- --evidence-dir /absolute/private/path/runtime-run-1
npm run test:compatibility -- --evidence-dir /absolute/private/path/box-run-1
```

The runtime check exercises provisioning, exact-byte uploads, nonzero command
exits, timeout/process termination, reconnect, non-resuming status, stop and
deletion. It does not test Box Mount. The compatibility check runs those command
semantics checks and the supplied Box Mount binary against a real Box folder.

For compatibility, provide `BOX_ACCESS_TOKEN`, `BOX_FOLDER_ID`,
`BOX_MOUNT_ARCHIVE`, and `BOX_MOUNT_SETUP_DOCS`. The current probe accepts the
vendor-checksummed Box Mount 0.5.0 Linux x86_64 archive. The setup-doc setting
points to a local capture of Box's preview documentation. Leave
`BOX_REVIEWER_USER_ID` unset. Start with a dedicated empty test folder; repeat
runs may retain the probe's uniquely named subfolders.

The probe creates a new synthetic subfolder and one non-persistent Vercel
sandbox with a 15-minute deadline. It verifies input sync from Box, output sync
to Box, a new Box file version reaching the same running session, and a final
write immediately before successful unmount. It downloads and hashes the
outputs before and after stopping/deleting compute. Box test files are retained
for inspection. No reviewer tasks or notifications are created.

Box Mount's unmount command launches a final sync process. With environment
credentials, pass the Box token to both mount and unmount. Supplying it only
to the original daemon is insufficient. Avoid passing Box credentials to an
untrusted agent; follow Box's separate-user and shared-directory guidance.

`COMPATIBILITY_PASS` requires all checks and cleanup to succeed. A failed sync
or unmount leaves `RECOVERY_REQUIRED` and the owned name in private evidence.
Investigate while the session remains live; its deadline still applies. Do not
stop a non-persistent session containing unsynced work. Stopping discards its
filesystem; deletion removes its record. Snapshots have a separate lifetime;
the probes create none and verify their absence.

Evidence contains hashes of source, SDK lockfile, archive, input/output bytes,
the observed image digest, session identity, command results and cleanup order.
A compatibility pass does not establish that the full contract-review demo ran.
