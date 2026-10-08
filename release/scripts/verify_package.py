#!/usr/bin/env python
"""Verify a release artifact before it goes to the Chrome Web Store.

Checks a zip (or an unpacked directory):
  1. manifest.json sits at the ZIP ROOT (a nested folder is the classic upload error).
  2. manifest.json is valid JSON, MV3, and has name/version/description.
  3. every file the manifest references exists inside the package.
  4. no dev-only files leaked in (.git, node_modules, release/, *.map, *.pem, .env…).
  5. no remote-code patterns (eval of fetched code, remote script tags, VM/Function abuse).
  6. size and entry-count sanity vs the store limit.
  7. no file that looks like a secret.

Exit code 0 = safe to upload, 2 = findings (all printed).

Usage: python verify_package.py <artifact.zip|unpacked-dir> [...]
"""

from __future__ import annotations

import json
import os
import re
import sys
import zipfile

STORE_SIZE_LIMIT = 2 * 1024 * 1024 * 1024  # Chrome Web Store per-item limit is 2 GB.
WARN_SIZE = 50 * 1024 * 1024

FORBIDDEN_PATH_PARTS = (
    ".git/", "node_modules/", "release/", "tests/", "test/", "__tests__/",
    "e2e/", "coverage/", "playwright-report/", "test-results/",
    "scripts/", "tools/", "ci/",
)
# NOTE: "security/" is intentionally NOT forbidden: the MVP extension ships
# security/operation-guard.mjs as *runtime* code (imported by src/admission.js).
FORBIDDEN_SUFFIXES = (".map", ".pem", ".key", ".p12", ".pfx", ".log", ".ts", ".tsx", ".snap")
FORBIDDEN_NAMES = (
    ".env", ".ds_store", "thumbs.db", ".gitignore", "package.json",
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "vitest.config.mjs",
    "playwright.config.mjs", "tsconfig.json",
)

REMOTE_CODE_PATTERNS = (
    (re.compile(rb"""\beval\s*\("""), "eval() in an extension page (MV3 forbids unsafe-eval)"),
    (re.compile(rb"""new\s+Function\s*\("""), "new Function() (MV3 forbids unsafe-eval)"),
    (re.compile(rb"""setTimeout\s*\(\s*['"]"""), "setTimeout with a string (implicit eval)"),
    (re.compile(rb"""\beval\s*\(\s*(?:await\s+)?(?:fetch|response|await)"""), "eval of a fetched response"),
    (re.compile(rb"""new\s+Function\s*\(\s*(?:await\s+)?(?:fetch|await)"""), "Function() built from a fetched response"),
    (re.compile(rb"""document\.createElement\(\s*['"]script['"]\s*\)[^;]{0,200}?\.src\s*=\s*['"]https?://""", re.S), "remote script element"),
    (re.compile(rb"""(?:importScripts|import)\s*\(\s*['"]https?://"""), "remote import"),
    (re.compile(rb"""chrome\.scripting\.executeScript[^)]{0,300}?\bfiles\s*:\s*\[\s*['"]https?://""", re.S), "executeScript from a remote file"),
)

SECRET_SUFFIXES = (".pem", ".p12", ".pfx", ".keystore", ".jks")
SECRET_MARKERS = ("secret", "credential", "creds", "id_rsa", "apikey", "api_key")

TEXT_SUFFIXES = (".js", ".mjs", ".cjs", ".html", ".htm", ".json", ".css")


class Report:
    def __init__(self, target: str) -> None:
        self.target = target
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.info: list[str] = []

    def error(self, message: str) -> None:
        self.errors.append(message)

    def warn(self, message: str) -> None:
        self.warnings.append(message)

    def note(self, message: str) -> None:
        self.info.append(message)


def load_entries(target: str):
    """Yield (name, size, read_bytes_callable) for the artifact."""
    if os.path.isdir(target):
        entries = []
        for root, _dirs, names in os.walk(target):
            for name in names:
                abs_path = os.path.join(root, name)
                rel = os.path.relpath(abs_path, target).replace("\\", "/")
                entries.append((rel, os.path.getsize(abs_path), (lambda p=abs_path: open(p, "rb").read())))
        return sorted(entries), None

    if not zipfile.is_zipfile(target):
        raise ValueError(f"{target} is not a zip file and not a directory")
    archive = zipfile.ZipFile(target)  # kept open: readers below read lazily
    entries = [
        (info.filename, info.file_size, (lambda n=info.filename: archive.read(n)))
        for info in archive.infolist() if not info.is_dir()
    ]
    return sorted(entries), archive


def manifest_references(manifest: dict) -> list[str]:
    refs: list[str] = []
    refs.extend((manifest.get("icons") or {}).values())
    for block in ("action", "browser_action", "sidebar_action", "page_action", "options_ui", "side_panel"):
        node = manifest.get(block) or {}
        refs.extend((node.get("default_icon") or {}).values())
        for key in ("default_popup", "default_panel", "page"):
            if node.get(key):
                refs.append(node[key])
    background = manifest.get("background") or {}
    if background.get("service_worker"):
        refs.append(background["service_worker"])
    refs.extend(background.get("scripts") or [])
    for entry in manifest.get("content_scripts") or []:
        refs.extend(entry.get("js") or [])
        refs.extend(entry.get("css") or [])
    for entry in manifest.get("web_accessible_resources") or []:
        resources = entry.get("resources") if isinstance(entry, dict) else entry
        refs.extend(resources or [])
    return [ref for ref in refs if isinstance(ref, str) and "*" not in ref]


def verify(target: str) -> Report:
    report = Report(target)
    try:
        entries, _archive = load_entries(target)
    except ValueError as exc:
        report.error(str(exc))
        return report

    names = {name for name, _size, _read in entries}
    total_size = sum(size for _n, size, _r in entries)
    report.note(f"entries={len(entries)} total={total_size} bytes")

    # 1. manifest at root
    if "manifest.json" not in names:
        nested = sorted(n for n in names if n.endswith("manifest.json"))
        hint = (
            f" — found at {nested[0]} instead; the store requires it at the ZIP root"
            if nested else ""
        )
        report.error(f"manifest.json is not at the package root{hint}")
        return report

    def read(name: str) -> bytes:
        for entry_name, _size, reader in entries:
            if entry_name == name:
                return reader()
        raise KeyError(name)

    # 2. manifest valid
    try:
        manifest = json.loads(read("manifest.json").decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        report.error(f"manifest.json does not parse: {exc}")
        return report

    for key in ("manifest_version", "name", "version", "description"):
        if not manifest.get(key):
            report.error(f"manifest.json has no {key!r}")
    if manifest.get("manifest_version") != 3:
        report.error(f"manifest_version is {manifest.get('manifest_version')!r}, not 3")
    report.note(
        f"manifest: name={manifest.get('name')!r} version={manifest.get('version')!r} "
        f"permissions={manifest.get('permissions')}"
    )
    if manifest.get("host_permissions") and any(
        host in ("<all_urls>",) for host in manifest["host_permissions"]
    ):
        report.warn("<all_urls> in host_permissions — reviewers will ask; prefer a narrower set")
    if "__MSG_" in str(manifest.get("name", "")) and "_locales" not in {n.split("/")[0] for n in names}:
        report.error("name uses __MSG_ placeholders but the package has no _locales/")

    # 3. references resolve
    referenced = {ref for ref in manifest_references(manifest)}
    missing = sorted(ref for ref in referenced if ref not in names)
    if missing:
        report.error("manifest references files missing from the package: " + ", ".join(missing))

    # 4. dev-only leakage (a path the manifest explicitly references is never "dev-only")
    for name in sorted(names):
        lowered = name.lower()
        if name in referenced:
            continue
        if any(part in name for part in FORBIDDEN_PATH_PARTS):
            report.error(f"dev-only path in package: {name}")
        if lowered.endswith(FORBIDDEN_SUFFIXES):
            report.error(f"dev-only file in package: {name}")
        if os.path.basename(lowered) in FORBIDDEN_NAMES:
            report.error(f"repo/secret file in package: {name}")

    # 5. remote code
    for name, size, reader in entries:
        if size > 4 * 1024 * 1024 or not name.lower().endswith(TEXT_SUFFIXES):
            continue
        try:
            data = reader()
        except Exception:  # noqa: BLE001
            continue
        for pattern, label in REMOTE_CODE_PATTERNS:
            if pattern.search(data):
                report.error(f"possible remote code in {name}: {label}")

    # 6. size sanity
    if total_size > STORE_SIZE_LIMIT:
        report.error(f"package is {total_size} bytes — over the store limit")
    elif total_size > WARN_SIZE:
        report.warn(f"package is {total_size / 1e6:.1f} MB — large; expect a slower review")

    # 7. secrets
    for name in sorted(names):
        lowered = name.lower()
        if lowered.endswith(SECRET_SUFFIXES) or any(m in lowered for m in SECRET_MARKERS):
            report.error(f"file looks like a secret: {name}")

    return report


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    failed = False
    for target in argv[1:]:
        report = verify(target)
        print(f"\n=== {target} ===")
        for line in report.info:
            print(f"  info : {line}")
        for line in report.warnings:
            print(f"  WARN : {line}")
        for line in report.errors:
            print(f"  FAIL : {line}")
        if report.errors:
            failed = True
            print(f"  -> {len(report.errors)} finding(s): do not upload this artifact")
        else:
            print("  -> OK: safe to upload")
    return 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
