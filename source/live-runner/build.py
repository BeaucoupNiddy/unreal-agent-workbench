#!/usr/bin/env python3
"""Build a live-input companion from clean upstream source without replacing it."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
PIN = "a5f3fd13032737142916523ae4344c392292f9d5"
SOURCE = "https://github.com/unreallabsai/unreal-agent.git"
FILES = ("runner.patch", "live_input.go", "live_input_test.go")


def run(*args, **kwargs):
    return subprocess.run(list(map(str, args)), check=True, **kwargs)


def extension_hash():
    digest = hashlib.sha256()
    for name in FILES:
        digest.update(name.encode())
        digest.update((ROOT / name).read_bytes())
    return digest.hexdigest()


def build(source, output, revision=PIN, official_runner=None):
    source, output = Path(source).resolve(), Path(output).resolve()
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    if actual != revision:
        raise RuntimeError(f"Expected upstream {revision}, got {actual}")
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=source, text=True).strip():
        raise RuntimeError("Companion builds require clean upstream source.")
    official = Path(official_runner or Path.home() / ".local/bin/unreal-agent-runner")
    official_hash = None
    if official.is_file():
        info = subprocess.check_output(["go", "version", "-m", str(official)], text=True)
        if "vcs.revision=" + revision not in info or "vcs.modified=true" in info:
            raise RuntimeError("Official runner does not match the clean companion source revision.")
        official_hash = hashlib.sha256(official.read_bytes()).hexdigest()
    output.parent.mkdir(parents=True, exist_ok=True)
    cache = ROOT / ".cache"
    cache.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="build-", dir=cache) as temporary:
        work = Path(temporary) / "source"
        shutil.copytree(source, work)
        run("git", "apply", "--check", ROOT / "runner.patch", cwd=work)
        run("git", "apply", ROOT / "runner.patch", cwd=work)
        package = work / "cmd/internal/agentrunner"
        for name in FILES[1:]:
            shutil.copy2(ROOT / name, package / name)
        unformatted = subprocess.check_output(["gofmt", "-l", str(package)], text=True).strip()
        if unformatted:
            raise RuntimeError(f"Unformatted companion code: {unformatted}")
        packages = ("./cmd/internal/agentrunner", "./harness/coordinator", "./harness/inbox")
        run("go", "test", "-race", *packages, cwd=work)
        run("go", "vet", *packages, cwd=work)
        binary = Path(temporary) / "unreal-agent-live-runner"
        run("go", "build", "-trimpath", "-o", binary, "./cmd/unreal-agent-runner", cwd=work)
        help_text = subprocess.check_output([str(binary), "--help"], stderr=subprocess.STDOUT, text=True)
        if "-live-input" not in help_text:
            raise RuntimeError("Companion is missing its live-input interface.")
        provenance = {"upstreamRevision": actual, "extensionSHA256": extension_hash(),
                      "binarySHA256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                      "officialBinarySHA256": official_hash}
        staged = output.with_name(f".{output.name}.{os.getpid()}.tmp")
        staged_info = Path(str(staged) + ".json")
        try:
            shutil.copy2(binary, staged)
            staged.chmod(0o755)
            staged_info.write_text(json.dumps(provenance, indent=2) + "\n")
            os.replace(staged, output)
            os.replace(staged_info, Path(str(output) + ".json"))
        finally:
            staged.unlink(missing_ok=True)
            staged_info.unlink(missing_ok=True)
    print(f"Built live-input companion: {output}", flush=True)
    return provenance


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Clean official checkout; otherwise clone the pinned revision")
    parser.add_argument("--output", type=Path, default=ROOT.parent / "unreal-agent-acp/runtime/unreal-agent-live-runner")
    parser.add_argument("--official-runner", type=Path, help="Official binary paired with this build")
    parser.add_argument("--revision", default=PIN, help="Expected source revision (updater supplies a validated descendant)")
    args = parser.parse_args()
    if args.source:
        build(args.source, args.output, args.revision, args.official_runner)
    else:
        cache = ROOT / ".cache"
        cache.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="upstream-", dir=cache) as directory:
            source = Path(directory) / "source"
            run("git", "clone", "--quiet", SOURCE, source)
            run("git", "checkout", "--quiet", args.revision, cwd=source)
            build(source, args.output, args.revision, args.official_runner)


if __name__ == "__main__":
    main()
