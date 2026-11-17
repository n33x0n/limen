# Local volume storage

Opt-in local storage for new Limen job directories and repository worktrees. Existing mounted paths remain in place. An absent or mismatched configured volume must stop job creation and continuation before writing.

## Configuration

The seat file `~/.config/limen/volume-storage.json` accepts either exactly `mount` (absolute normalized mountpoint) and `uuid` (Linux filesystem UUID), or exactly those fields plus `workspace` (absolute normalized workspace) and `layout: "named"`. An absent file preserves upstream behavior. The old two-field form preserves managed-hash storage. Invalid configuration or an unavailable filesystem refuses; it never falls back to the system disk. This is local operator configuration, not repository content.

Named mode stores workspace jobs at `<mount>/limen-jobs/workspace`, independent immediate-child plant jobs at `<mount>/limen-jobs/plants/<child>`, ordinary worktree containers at `<mount>/limen-worktrees/<repo-directory>`, and historical containers at `<mount>/limen-worktrees/_legacy/<old-container-without-leading-dot>`. `_legacy` is reserved. Job ownership comes from the lexical cabinet under the configured workspace, not its symlink destination or a temporary worktree. Worktree ownership comes from the repository's Git common directory. Unknown or ambiguous shapes refuse.

Named roots and leaves must be physical directories on the configured filesystem, without symlink components or bind aliases. An existing visible path is accepted only when its device and inode equal the canonical named directory. Legacy hash destinations are never adopted as canonical storage. An existing canonical destination without the matching visible alias refuses as a collision; publication races accept only exact identity. No host migration, archive lookup, or record rewriting is performed.

## Invariants

- New job storage and worktree containers use the configured filesystem; existing migrated mounts and job paths remain valid.
- A new repository's worktree container is provisioned automatically without moving its main checkout.
- Creating and continuing a job refuse before publication when the mounted filesystem is missing or has another UUID.
- Prune uses the same worktree container as spawn and leaves running jobs alone.
- No existing data is moved or removed when enabling the option.

## Verification

Use one focused synthetic verification for new publication, reads, continuation, Git and project-scoped prune; old configs and aliases; wrong UUID, same-device/different-inode aliases, hash targets, collisions, and symlink escapes. This is a local CLI, not an MCP server; the MCP-specific check-tool protocol does not apply.
