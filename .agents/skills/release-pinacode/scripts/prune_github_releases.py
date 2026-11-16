#!/usr/bin/env python3
"""Keep the verified latest PinaCode Release; retain all Git tags."""

import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys

REPOSITORY = "zjywill/PinaCode"


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True)


def latest():
    return json.loads(gh("api", "repos/" + REPOSITORY + "/releases/latest"))


def releases():
    pages = json.loads(
        gh("api", "--paginate", "--slurp", "repos/" + REPOSITORY + "/releases?per_page=100")
    )
    return [release for page in pages for release in page]


def plan(current, all_releases, keep):
    if current["tag_name"] != keep or current["draft"] or current["prerelease"]:
        raise RuntimeError("--keep must name the current published stable latest Release.")
    if sum(item["id"] == current["id"] for item in all_releases) != 1:
        raise RuntimeError("Latest Release is missing or duplicated in the snapshot.")
    published_at = datetime.fromisoformat(current["published_at"].replace("Z", "+00:00"))
    for item in all_releases:
        if item["id"] == current["id"]:
            continue
        if any(
            datetime.fromisoformat(value.replace("Z", "+00:00")) > published_at
            for value in (item["created_at"], item["published_at"])
            if value is not None
        ):
            raise RuntimeError("A newer draft or Release exists; inspect concurrent publishing before pruning.")
    assets = {item["name"]: item for item in current["assets"]}
    installers = [name for name in assets if name.endswith((".dmg", ".zip"))]
    if not any(name.endswith(".dmg") for name in installers) or not any(
        name.endswith(".zip") for name in installers
    ):
        raise RuntimeError("The retained Release must contain both a macOS DMG and ZIP.")
    required = {"latest-mac.yml", "SHA256SUMS"}
    required.update(name + ".blockmap" for name in installers)
    if not required.issubset(assets) or any(
        item.get("state") != "uploaded" or item.get("size", 0) <= 0
        for item in assets.values()
    ):
        raise RuntimeError("The retained Release has missing or incomplete assets.")
    return [item for item in all_releases if item["id"] != current["id"]]


def prune(current, doomed):
    for item in doomed:
        if latest()["id"] != current["id"]:
            raise RuntimeError("Latest Release changed; stopped before the next deletion.")
        gh("api", "--method", "DELETE", "repos/" + REPOSITORY + "/releases/" + str(item["id"]))
        print("Deleted Release " + item["tag_name"] + " (ID " + str(item["id"]) + ")", flush=True)
    remaining = releases()
    if latest()["id"] != current["id"] or len(remaining) != 1 or remaining[0]["id"] != current["id"]:
        raise RuntimeError("Release state changed or pruning is incomplete; inspect before continuing.")
    print("Only retained Release remains: " + current["tag_name"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, choices=[REPOSITORY])
    parser.add_argument("--keep", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--snapshot", type=Path)
    args = parser.parse_args()
    current = latest()
    all_releases = releases()
    doomed = plan(current, all_releases, args.keep)
    manifest = gh("release", "download", args.keep, "--repo", REPOSITORY,
                  "--pattern", "latest-mac.yml", "--output", "-")
    match = re.search(r"(?m)^version:\s*['\"]?([^'\"\s]+)", manifest)
    if not match or match.group(1) != args.keep.removeprefix("v"):
        raise RuntimeError("The downloadable update manifest does not match --keep.")
    print("Keep: " + current["tag_name"] + " (ID " + str(current["id"]) + ")")
    for item in doomed:
        print("Remove: " + item["tag_name"] + " (ID " + str(item["id"]) + ")")
    print("Planned deletions: " + str(len(doomed)) + "; Git tags are retained.")
    if args.snapshot:
        with args.snapshot.open("x") as output:
            os.chmod(args.snapshot, 0o600)
            json.dump({"keepId": current["id"], "releases": all_releases}, output, indent=2)
    if args.apply:
        prune(current, doomed)
    else:
        print("Read-only preview; use --apply to execute.")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print("Stopped: " + str(error), file=sys.stderr)
        sys.exit(1)
