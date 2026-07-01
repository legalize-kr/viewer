#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import struct
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

ALLOWED_REPOS = {"legalize-kr", "precedent-kr", "admrule-kr", "ordinance-kr"}
SAFE_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$")


def default_workspace() -> Path:
    return Path(os.environ.get("LEGALIZE_WORKSPACE_ROOT", Path(__file__).resolve().parents[2])).resolve()


def safe_repo_path(workspace: Path, repo: str) -> Path:
    if repo not in ALLOWED_REPOS:
        raise ValueError("unsupported repo")
    repo_path = (workspace / repo).resolve()
    if not repo_path.is_dir():
        raise ValueError("repo not found")
    return repo_path


def safe_file_path(path: str) -> str:
    candidate = Path(path)
    if candidate.is_absolute() or ".." in candidate.parts or not path:
        raise ValueError("invalid path")
    return path


def safe_ref(ref: str) -> str:
    if not SAFE_REF.match(ref) or ".." in ref.split("/"):
        raise ValueError("invalid ref")
    return ref


def git(repo_path: Path, args: list[str]) -> bytes:
    return subprocess.check_output(["git", "-C", str(repo_path), *args], stderr=subprocess.STDOUT)


def handle_raw(workspace: Path, message: dict) -> str:
    repo = str(message.get("repo", ""))
    path = safe_file_path(str(message.get("path", "")))
    ref = safe_ref(str(message.get("ref", "HEAD")))
    repo_path = safe_repo_path(workspace, repo)
    return git(repo_path, ["show", f"{ref}:{path}"]).decode("utf-8", errors="replace")


def handle_commits(workspace: Path, message: dict) -> list[dict]:
    repo = str(message.get("repo", ""))
    path = safe_file_path(str(message.get("path", "")))
    limit = min(max(int(message.get("limit", 80)), 1), 100)
    until = str(message.get("until", "") or "")
    repo_path = safe_repo_path(workspace, repo)
    args = ["log", "--follow", f"--max-count={limit}", "--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s"]
    if until:
        args.append(f"--until={until}")
    args.extend(["--", path])
    output = git(repo_path, args).decode("utf-8", errors="replace")
    commits = []
    for line in output.splitlines():
        sha, short_sha, date, author, subject = (line.split("\x1f", 4) + ["", "", "", "", ""])[:5]
        if not sha:
            continue
        encoded_path = quote(path, safe="/")
        commits.append(
            {
                "sha": sha,
                "shortSha": short_sha,
                "date": date,
                "message": subject,
                "author": author,
                "htmlUrl": f"native://commit/{quote(repo)}/{quote(sha)}",
                "rawUrl": f"native://raw/{quote(repo)}/{encoded_path}?ref={quote(sha)}",
            }
        )
    return commits


def dispatch(workspace: Path, message: dict) -> dict:
    request_id = message.get("id")
    try:
        message_type = message.get("type")
        if message_type == "raw":
            return {"id": request_id, "ok": True, "data": handle_raw(workspace, message)}
        if message_type == "commits":
            return {"id": request_id, "ok": True, "data": handle_commits(workspace, message)}
        raise ValueError("unsupported message type")
    except (ValueError, subprocess.CalledProcessError) as error:
        detail = error.output.decode("utf-8", errors="replace").strip() if isinstance(error, subprocess.CalledProcessError) else str(error)
        return {"id": request_id, "ok": False, "error": detail or "native host request failed"}


def read_message(stdin) -> dict | None:
    raw_length = stdin.read(4)
    if not raw_length:
        return None
    if len(raw_length) != 4:
        raise ValueError("invalid native message length header")
    length = struct.unpack("<I", raw_length)[0]
    if length > 1_048_576:
        raise ValueError("native message too large")
    payload = stdin.read(length)
    if len(payload) != length:
        raise ValueError("truncated native message")
    return json.loads(payload.decode("utf-8"))


def write_message(stdout, message: dict) -> None:
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    stdout.write(struct.pack("<I", len(payload)))
    stdout.write(payload)
    stdout.flush()


def serve(workspace: Path) -> None:
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    while True:
        message = read_message(stdin)
        if message is None:
            return
        write_message(stdout, dispatch(workspace, message))


def self_test() -> None:
    assert safe_file_path("kr/형법/법률.md") == "kr/형법/법률.md"
    for bad_path in ("", "../secret", "/tmp/file"):
        try:
            safe_file_path(bad_path)
            raise AssertionError(f"bad path accepted: {bad_path}")
        except ValueError:
            pass
    assert safe_ref("main") == "main"
    for bad_ref in ("../main", "bad ref", ""):
        try:
            safe_ref(bad_ref)
            raise AssertionError(f"bad ref accepted: {bad_ref}")
        except ValueError:
            pass
    from io import BytesIO

    stream = BytesIO()
    write_message(stream, {"id": "1", "ok": True, "data": "pong"})
    stream.seek(0)
    assert read_message(stream) == {"id": "1", "ok": True, "data": "pong"}


def main() -> None:
    parser = argparse.ArgumentParser(description="Legalize-KR Viewer Native Messaging host prototype")
    parser.add_argument("--workspace", default=str(default_workspace()))
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    serve(Path(args.workspace).resolve())


if __name__ == "__main__":
    main()
