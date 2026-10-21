#!/usr/bin/env python3
"""Generates latex-runner/seccomp.json: Docker's default seccomp profile (moby/profiles, Apache-2.0)
plus what bubblewrap needs to build its sandbox without any capability: unshare/clone with namespace
flags, mount/umount2/mount_setattr/open_tree/move_mount and pivot_root (only effective inside the new user namespace, since the container
keeps no capabilities). clone3 stays ENOSYS so glibc falls back to clone.

Usage: python3 scripts/gen-seccomp.py <moby default.json> > seccomp.json
Source used: https://raw.githubusercontent.com/moby/profiles/main/seccomp/default.json
"""
import json
import sys

profile = json.load(open(sys.argv[1]))
NEEDED = ["clone", "unshare", "mount", "umount", "umount2", "pivot_root", "setns", "mount_setattr", "open_tree", "move_mount"]
rules = []
for rule in profile["syscalls"]:
    # Drop the flag-restricted clone rules (no CLONE_NEW*); the unconditional rule below replaces them.
    if rule["names"] == ["clone"] and rule.get("action") == "SCMP_ACT_ALLOW" and "args" in rule:
        continue
    rules.append(rule)
rules.append({
    "names": NEEDED,
    "action": "SCMP_ACT_ALLOW",
    "comment": "latex-runner: bubblewrap creates user/mount/pid/net namespaces per compile without capabilities",
})
profile["syscalls"] = rules
json.dump(profile, sys.stdout, indent=1)
sys.stdout.write("\n")
