#!/usr/bin/env python
"""Diff manifest permissions against the justification document.

The store rejects an item whose justification does not match the manifest in either
direction: a permission with no justification ("why do you need this?"), or a justification
for a permission that is no longer requested (evidence the submission was not reviewed against
the build).

Usage:
  python check_permissions.py [--manifest PATH] [--doc PATH]

Exit 0 = every declared permission has a block and every block is still declared,
2 = drift (listed), 1 = a file is unreadable.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RELEASE_DIR = os.path.dirname(HERE)

# Blocks in the document look like:  ## `debugger` — the one that gets extensions rejected
BLOCK_RE = re.compile(r"^##\s+`([A-Za-z][A-Za-z0-9_]*)`", re.MULTILINE)


def declared_permissions(manifest_path: str) -> tuple[list[str], list[str]]:
    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    return (
        list(manifest.get("permissions") or []),
        list(manifest.get("host_permissions") or []),
    )


def documented_permissions(doc_path: str) -> list[str]:
    with open(doc_path, encoding="utf-8") as handle:
        return BLOCK_RE.findall(handle.read())


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", default=None)
    parser.add_argument("--doc", default=os.path.join(RELEASE_DIR, "store", "permission-justifications.md"))
    parser.add_argument("--unpacked", default=os.path.join(RELEASE_DIR, "dist", "unpacked"))
    args = parser.parse_args(argv[1:])

    manifest_path = args.manifest or os.path.join(args.unpacked, "manifest.json")
    if not os.path.exists(manifest_path):
        print(f"check-permissions: no manifest at {manifest_path} — build first", file=sys.stderr)
        return 1
    if not os.path.exists(args.doc):
        print(f"check-permissions: no justification doc at {args.doc}", file=sys.stderr)
        return 1

    permissions, hosts = declared_permissions(manifest_path)
    documented = documented_permissions(args.doc)

    missing = [p for p in permissions if p not in documented]
    stale = [p for p in documented if p not in permissions]

    print(f"manifest: {len(permissions)} permissions, {len(hosts)} host permissions")
    print("  " + ", ".join(permissions))
    print(f"doc:      {len(documented)} justification blocks")

    drift = False
    if missing:
        drift = True
        print("\nFAIL — declared but NOT justified in the doc:")
        for name in missing:
            print(f"  - {name}")
    if stale:
        drift = True
        print("\nFAIL — justified in the doc but no longer declared:")
        for name in stale:
            print(f"  - {name}    (remove the block or re-add the permission)")
    if hosts:
        print("\nhost permissions (covered by the 'Host permissions' section):")
        for host in hosts:
            print(f"  - {host}")
    if not drift:
        print("\nOK — the document matches the manifest in both directions")
    return 2 if drift else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
