#!/usr/bin/env python
"""Build a Chrome Web Store / self-hosted release package for a browser extension.

Produces, in the output directory:
  unpacked/                      loadable "load unpacked" build (version-stamped)
  hermes-browser-extension-<v>.zip   store upload artifact (manifest.json at zip root)
  release-manifest.json          machine-readable build record (hashes, sizes, permissions)
  SHA256SUMS                     checksums of the artifacts

Excludes dev/repo files (.git, node_modules, release/, tests, source maps, keys, .env).

Usage:
  python build_release.py --source <extension-dir> [--version X.Y.Z] [--out DIR]
                          [--unpacked-only] [--allow-dirty] [--name <slug>]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
import zipfile

EXCLUDE_DIRS = {
    ".git", ".github", ".vscode", ".idea", "node_modules", "release", "dist",
    "build", "out", "coverage", "tests", "test", "__tests__", "e2e",
    "playwright-report", "test-results", "screenshots", "tmp",
    # repo tooling that may sit next to the extension
    # NOTE: "security" is deliberately NOT excluded — this build's extension imports
    # extension/security/operation-guard.mjs at runtime (src/admission.js), so it is
    # shipped code, not repo tooling.
    "scripts", "docs", "tools", "dev", "ci", ".devcontainer", "fixtures",
}
EXCLUDE_FILE_SUFFIXES = (
    ".map", ".pem", ".key", ".log", ".ts", ".tsx", ".zip", ".crx", ".psd", ".ai",
    ".mdx", ".snap",
)
EXCLUDE_FILE_NAMES = {
    ".ds_store", "thumbs.db", ".gitignore", ".gitattributes", ".env",
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    # build/test config never ships inside an extension package
    "package.json", "tsconfig.json", "tsconfig.node.json", ".editorconfig",
    "vitest.config.mjs", "vitest.config.ts", "vitest.config.js",
    "playwright.config.mjs", "playwright.config.ts", "playwright.config.js",
    "jest.config.mjs", "jest.config.ts", "jest.config.js",
    "vite.config.ts", "vite.config.mjs", "vite.config.js",
    ".eslintrc", ".eslintrc.json", ".eslintrc.cjs", ".prettierrc", ".prettierrc.json",
}
EXCLUDE_FILE_PREFIXES = ("vitest.config.", "playwright.config.", "jest.config.", "vite.config.", ".eslintrc", ".prettierrc", "tsconfig.")
SECRET_NAME_MARKERS = (
    "secret", "credential", "creds", "id_rsa", "apikey", "api_key",
)
SECRET_SUFFIXES = (".pem", ".p12", ".pfx", ".keystore", ".jks", ".key")

REQUIRED_MANIFEST_KEYS = ("manifest_version", "name", "version")


class BuildError(Exception):
    pass


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_excluded_file(name: str) -> bool:
    lowered = name.lower()
    if lowered in EXCLUDE_FILE_NAMES:
        return True
    if lowered.startswith(".env"):
        return True
    if lowered.startswith(EXCLUDE_FILE_PREFIXES):
        return True
    if lowered.endswith(EXCLUDE_FILE_SUFFIXES):
        return True
    return False


def looks_like_secret(rel: str) -> bool:
    lowered = rel.lower()
    if lowered.endswith(SECRET_SUFFIXES):
        return True
    return any(marker in lowered for marker in SECRET_NAME_MARKERS)


def collect(source: str) -> list[tuple[str, str]]:
    """Return [(absolute_path, relative_posix_path)] for the files to ship."""
    files: list[tuple[str, str]] = []
    for root, dirs, names in os.walk(source):
        rel_root = os.path.relpath(root, source)
        if rel_root == ".":
            rel_root = ""
        dirs[:] = [
            d for d in dirs
            if not (d.startswith(".") or d in EXCLUDE_DIRS)
        ]
        for name in names:
            rel = f"{rel_root}/{name}" if rel_root else name
            rel = rel.replace("\\", "/")
            if is_excluded_file(name):
                continue
            if looks_like_secret(rel):
                raise BuildError(
                    f"refusing to package a file that looks like a secret: {rel}"
                )
            files.append((os.path.join(root, name), rel))
    files.sort(key=lambda pair: pair[1])
    return files


def read_manifest(source: str) -> dict:
    path = os.path.join(source, "manifest.json")
    if not os.path.exists(path):
        raise BuildError(f"no manifest.json in {source}")
    with open(path, encoding="utf-8") as handle:
        try:
            return json.load(handle)
        except json.JSONDecodeError as exc:
            raise BuildError(f"manifest.json is not valid JSON: {exc}") from exc


def validate_manifest(manifest: dict, source: str) -> None:
    for key in REQUIRED_MANIFEST_KEYS:
        if not manifest.get(key):
            raise BuildError(f"manifest.json is missing required key: {key}")
    if int(manifest["manifest_version"]) != 3:
        raise BuildError(
            f"only Manifest V3 is supported for Chrome Web Store, found "
            f"manifest_version={manifest['manifest_version']}"
        )

    referenced: list[str] = []
    for value in (manifest.get("icons") or {}).values():
        referenced.append(value)
    for block in ("action", "browser_action", "sidebar_action", "page_action"):
        node = manifest.get(block) or {}
        referenced.extend((node.get("default_icon") or {}).values())
        for key in ("default_popup", "default_panel"):
            if node.get(key):
                referenced.append(node[key])
    if manifest.get("background", {}).get("service_worker"):
        referenced.append(manifest["background"]["service_worker"])
    referenced.extend((manifest.get("background", {}).get("scripts") or []))
    if manifest.get("side_panel", {}).get("default_path"):
        referenced.append(manifest["side_panel"]["default_path"])
    if manifest.get("options_page"):
        referenced.append(manifest["options_page"])
    if manifest.get("options_ui", {}).get("page"):
        referenced.append(manifest["options_ui"]["page"])
    for entry in manifest.get("content_scripts") or []:
        referenced.extend(entry.get("js") or [])
        referenced.extend(entry.get("css") or [])
    for entry in manifest.get("web_accessible_resources") or []:
        resources = entry.get("resources") if isinstance(entry, dict) else entry
        referenced.extend(resources or [])

    missing = sorted({
        ref for ref in referenced
        if isinstance(ref, str)
        and "*" not in ref
        and not os.path.exists(os.path.join(source, ref))
    })
    if missing:
        raise BuildError("manifest references missing files: " + ", ".join(missing))


def stamp_version(unpacked: str, version: str | None) -> str:
    path = os.path.join(unpacked, "manifest.json")
    with open(path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    if version:
        if manifest.get("version") != version:
            print(f"  version: manifest={manifest.get('version')} -> release={version}")
        manifest["version"] = version
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(manifest, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    return manifest.get("version", "")


def stage(source: str, files: list[tuple[str, str]], unpacked: str) -> None:
    if os.path.exists(unpacked):
        shutil.rmtree(unpacked)
    for abs_path, rel in files:
        target = os.path.join(unpacked, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(abs_path, target)


def write_zip(unpacked: str, zip_path: str) -> int:
    total = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for root, dirs, names in os.walk(unpacked):
            dirs.sort()
            for name in sorted(names):
                abs_path = os.path.join(root, name)
                rel = os.path.relpath(abs_path, unpacked).replace("\\", "/")
                archive.write(abs_path, rel)
                total += 1
    return total


def git_dirty(source: str) -> bool:
    try:
        import subprocess
        result = subprocess.run(
            ["git", "-C", source, "status", "--porcelain"],
            capture_output=True, text=True, timeout=15,
        )
    except Exception:
        return False
    if result.returncode != 0:
        return False
    return bool(result.stdout.strip())


def main() -> int:
    repo_release = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    repo_root = os.path.dirname(repo_release)

    parser = argparse.ArgumentParser(description=__doc__)
    # The release toolkit now lives INSIDE the MVP tree (mvp/release/), and the thing it
    # packages is the loadable extension only (mvp/extension/) — not the whole MVP repo.
    parser.add_argument("--source", default=os.path.join(repo_root, "extension"),
                        help="extension source directory (default: <repo>/extension)")
    parser.add_argument("--out", default=os.path.join(repo_release, "dist"))
    parser.add_argument("--version", default=None, help="override the version to stamp")
    parser.add_argument("--name", default="hermes-browser-extension", help="package slug")
    parser.add_argument("--unpacked-only", action="store_true")
    parser.add_argument("--allow-dirty", action="store_true")
    args = parser.parse_args()

    source = os.path.abspath(args.source)
    out = os.path.abspath(args.out)
    slug = args.name or os.path.basename(source.rstrip("/\\"))

    version = args.version
    version_file = os.path.join(repo_release, "VERSION")
    if not version and os.path.exists(version_file):
        with open(version_file, encoding="utf-8") as handle:
            version = handle.read().strip()
    if not version:
        version = str(read_manifest(source).get("version") or "0.0.0")

    print(f"build: source={source}")
    print(f"build: out={out}  version={version}  slug={slug}")

    if not args.allow_dirty and git_dirty(source):
        raise BuildError(
            "git tree is dirty; commit first or pass --allow-dirty for a test build"
        )

    manifest = read_manifest(source)
    validate_manifest(manifest, source)
    files = collect(source)
    print(f"build: {len(files)} files to package")

    os.makedirs(out, exist_ok=True)
    unpacked = os.path.join(out, "unpacked")
    stage(source, files, unpacked)
    stamped = stamp_version(unpacked, version)

    file_hashes = {}
    total_bytes = 0
    for root, _dirs, names in os.walk(unpacked):
        for name in names:
            abs_path = os.path.join(root, name)
            rel = os.path.relpath(abs_path, unpacked).replace("\\", "/")
            file_hashes[rel] = sha256_file(abs_path)
            total_bytes += os.path.getsize(abs_path)

    zip_name = f"{slug}-{stamped}.zip"
    zip_path = os.path.join(out, zip_name)
    zip_count = 0
    if not args.unpacked_only:
        zip_count = write_zip(unpacked, zip_path)
        print(f"build: zip -> {zip_path} ({zip_count} entries)")

    record = {
        "name": slug,
        "version": stamped,
        # Repository-relative on purpose: the release record is published, so it must not
        # carry the absolute path of the machine that built it.
        "source": os.path.relpath(source, os.getcwd()).replace(os.sep, "/"),
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "files": len(file_hashes),
        "bytes": total_bytes,
        "manifest": {
            "manifest_version": read_manifest(unpacked).get("manifest_version"),
            "name": read_manifest(unpacked).get("name"),
            "permissions": read_manifest(unpacked).get("permissions", []),
            "host_permissions": read_manifest(unpacked).get("host_permissions", []),
        },
        "artifacts": {"unpacked": "unpacked"},
        "fileHashes": file_hashes,
    }
    if not args.unpacked_only:
        record["artifacts"]["zip"] = zip_name
        record["artifacts"]["zipSha256"] = sha256_file(zip_path)

    manifest_path = os.path.join(out, "release-manifest.json")
    with open(manifest_path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(record, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    sums_path = os.path.join(out, "SHA256SUMS")
    with open(sums_path, "w", encoding="utf-8", newline="\n") as handle:
        if not args.unpacked_only:
            handle.write(f"{sha256_file(zip_path)}  {zip_name}\n")
        for rel, digest in sorted(file_hashes.items()):
            handle.write(f"{digest}  unpacked/{rel}\n")

    print(f"build: record -> {manifest_path}")
    print(f"build: ok  version={stamped}  files={len(file_hashes)}  bytes={total_bytes}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BuildError as error:
        print(f"build: FAILED: {error}", file=sys.stderr)
        sys.exit(2)
