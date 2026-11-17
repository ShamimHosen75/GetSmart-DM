"""Print the Chrome extension ID that follows from a public key.

Chrome derives the ID from the DER public key in manifest.json "key":
first 16 bytes of SHA-256, each hex digit 0-f mapped to a-p.

Usage:
  python scripts/extension_id.py                    # reads extension/manifest.json
  python scripts/extension_id.py --pem extension-key.pem
  python scripts/extension_id.py --pem extension-key.pem --print-key
      (prints the base64 public key to paste into manifest.json "key")

--pem needs the `openssl` command line tool. Standard library only otherwise.
"""

import argparse
import base64
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def id_from_der(der: bytes) -> str:
    digest = hashlib.sha256(der).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def der_from_pem(pem_path: Path) -> bytes:
    return subprocess.run(
        ["openssl", "rsa", "-in", str(pem_path), "-pubout", "-outform", "DER"],
        check=True,
        capture_output=True,
    ).stdout


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pem", type=Path, help="private key file (extension-key.pem)")
    parser.add_argument("--print-key", action="store_true", help="also print the manifest key")
    args = parser.parse_args()

    if args.pem:
        der = der_from_pem(args.pem)
    else:
        manifest = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
        der = base64.b64decode(manifest["key"])

    if args.print_key:
        print("key:", base64.b64encode(der).decode("ascii"))
    print("id: ", id_from_der(der))


if __name__ == "__main__":
    main()
