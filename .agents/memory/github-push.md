---
name: GitHub push authentication
description: Workspace-specific guidance for pushing to the connected GitHub repository.
---

The workspace may contain a malformed or missing GitHub remote even when the repository is known. The GitHub API token can authenticate successfully while a Git push using a Bearer extra header fails; use an HTTPS Basic header built from `x-access-token:<token>` for the one-time push, without storing the token in the remote URL.

**Why:** The connected repository accepted the API token and the Basic Git transport, while the initial remote and Bearer transport did not.

**How to apply:** Inspect `git remote -v`, ensure a normal `origin` URL exists, and use a transient credential/header for pushes.