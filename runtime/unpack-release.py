import pathlib
import sys
import tarfile

archive, destination = sys.argv[1:]
with tarfile.open(archive, "r:gz") as bundle:
    members = bundle.getmembers()
    total = 0
    paths = set()
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != "command-space":
            raise ValueError("Release archive contains an invalid path")
        if not member.isfile() and not member.isdir():
            raise ValueError("Release archive contains a link or special file")
        if path in paths:
            raise ValueError("Release archive contains duplicate paths")
        paths.add(path)
        total += member.size
        if member.size > 128 * 1024 * 1024 or total > 512 * 1024 * 1024 or len(members) > 10000:
            raise ValueError("Release archive exceeds extraction limits")
        member.mode = 0o755 if member.isdir() or member.mode & 0o111 else 0o644
    bundle.extractall(destination, members=members, filter="data")
