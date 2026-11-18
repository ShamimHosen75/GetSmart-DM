"""Build the Windows setup program for the SIDM companion (Step 6).

    python scripts/build_setup.py            # -> dist/sidm-v<version>-companion-setup.exe

Needs NSIS 3 (makensis): `sudo apt-get install nsis` on Linux, or the NSIS
installer on Windows. scripts/release.py calls build_setup() for the
"companion-setup" download. The script is companion/windows/sidm-setup.nsi.
Standard library only.
"""

import argparse
import os
import shutil
import struct
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETUP_NAME = "sidm-v{version}-companion-setup.exe"
ICON_SIZES = (16, 32, 48, 128)


class SetupError(Exception):
    pass


def find_makensis():
    for name in ("makensis", "makensis.exe"):
        path = shutil.which(name)
        if path:
            return path
    for path in (r"C:\Program Files (x86)\NSIS\makensis.exe", r"C:\Program Files\NSIS\makensis.exe"):
        if os.path.isfile(path):
            return path
    return None


def make_ico(png_paths, out_path):
    """A Windows .ico holding the PNG icons as they are (Windows Vista and later read PNG entries)."""
    images = []
    for path in png_paths:
        with open(path, "rb") as f:
            data = f.read()
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            raise SetupError(f"{path} is not a PNG")
        width, height = struct.unpack(">II", data[16:24])
        images.append((width, height, data))
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    for width, height, data in images:
        entries += struct.pack("<BBBBHHII", width % 256, height % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    with open(out_path, "wb") as f:
        f.write(header + entries + b"".join(d for _, _, d in images))


def build_setup(root, version, out_dir, test_skip_tools=False):
    """Build the setup .exe into out_dir and return its path."""
    makensis = find_makensis()
    if not makensis:
        raise SetupError("makensis was not found: install NSIS 3 (Linux: sudo apt-get install nsis)")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, SETUP_NAME.format(version=version))
    script = os.path.join(root, "companion", "windows", "sidm-setup.nsi")
    with tempfile.TemporaryDirectory(prefix="sidm-setup-") as work:
        # The .bat files must have Windows line endings, whatever git checked out.
        src = os.path.join(work, "src")
        os.makedirs(src)
        for name in ("host.py", "install.bat", "update.bat", "README.md"):
            with open(os.path.join(root, "companion", name), "rb") as f:
                data = f.read()
            if name.endswith(".bat"):
                data = data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
            with open(os.path.join(src, name), "wb") as f:
                f.write(data)
        icon = os.path.join(work, "sidm.ico")
        make_ico([os.path.join(root, "extension", "icons", f"icon{s}.png") for s in ICON_SIZES], icon)
        tmp_out = os.path.join(work, "setup.exe")
        defines = {"VERSION": version, "SRC": src, "ICON": icon, "OUTFILE": tmp_out}
        if test_skip_tools:
            defines["TEST_SKIP_TOOLS"] = "1"
        cmd = [makensis, "-V2", "-INPUTCHARSET", "UTF8"] + [f"-D{k}={v}" for k, v in defines.items()] + [script]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise SetupError(f"makensis failed:\n{result.stdout}\n{result.stderr}")
        shutil.copyfile(tmp_out, out_path)
    return out_path


def main(argv=None):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from release import read_extension_version  # noqa: E402

    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--out", default=os.path.join(ROOT, "dist"), help="folder for the .exe (default: dist/)")
    args = parser.parse_args(argv)
    try:
        path = build_setup(ROOT, read_extension_version(ROOT), args.out)
    except SetupError as err:
        print(f"build_setup.py: error: {err}", file=sys.stderr)
        return 1
    print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
