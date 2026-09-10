import io
import sys
import tarfile

source, destination, kind = sys.argv[1:]
with tarfile.open(source, "r:gz") as original, tarfile.open(destination, "w:gz", format=tarfile.USTAR_FORMAT) as target:
    for item in original:
        target.addfile(item, original.extractfile(item) if item.isfile() else None)

    item = tarfile.TarInfo("super-space/extra")
    if kind == "traversal":
        item.name = "super-space/../../escaped"
    elif kind == "symlink":
        item.type = tarfile.SYMTYPE
        item.linkname = "../../escaped"
    elif kind == "hardlink":
        item.type = tarfile.LNKTYPE
        item.linkname = "super-space/bin/super-space"
    elif kind == "duplicate":
        item.name = "super-space/bin/super-space"
    target.addfile(item, io.BytesIO(b""))
