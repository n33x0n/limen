# Local volume storage

Opt-in local storage for new Limen job directories and repository worktrees. Existing mounted paths remain in place. An absent or mismatched configured volume must stop job creation and continuation before writing.

## Configuration

The seat file `~/.config/limen/volume-storage.json` is an object with exactly `mount` (absolute mountpoint path) and `uuid` (Linux filesystem UUID). An absent file preserves upstream behavior. An invalid file or unavailable filesystem is an error, never a reason to use the system disk. This file is local operator configuration, not repository content. The mounted directory `limen-managed` must be writable by the seat user.

## Invariants

- New job storage and worktree containers use the configured filesystem; existing migrated mounts and job paths remain valid.
- A new repository's worktree container is provisioned automatically without moving its main checkout.
- Creating and continuing a job refuse before publication when the mounted filesystem is missing or has another UUID.
- Prune uses the same worktree container as spawn and leaves running jobs alone.
- No existing data is moved or removed when enabling the option.

## Verification

Exercise spawn and continuation in isolated fixture repositories, verify actual device identities, missing/mismatched-volume refusal and existing paths, then independently review the exact commit. This is a local CLI, not an MCP server; the MCP-specific check-tool protocol does not apply.
