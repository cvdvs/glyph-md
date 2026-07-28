#!/usr/bin/env python3
"""Bakes the shared UI into a C header so the portable build is a single file.

The macOS app ships Resources/ inside the .app bundle and reads them at runtime.
Windows and Linux have no bundle, so the same bytes are compiled in instead.

    python3 Scripts/embed-resources.py shell/resources.h

Everything here is deliberately BINARY. Resources/viewer.html carries em dashes
and the smoke script carries a literal U+00A0 and U+200B that are the actual
inputs of the typing-rule assertions (CLAUDE.md rule 7). Reading in text mode
would decode and re-encode them; on Windows it would also turn every "\\n" into
"\\r\\n". Either one changes the bytes, and the damage is invisible: the page
still loads, the typing rules just quietly stop matching, on one platform only.
So the file is read as bytes, written as bytes, and then read BACK and checked
against a sha256 of the original before this script is allowed to succeed.

That self-check proves the TRANSPORT is exact. It cannot prove the INPUT is,
because a faithful copy of a corrupted checkout hashes fine. So the sources are
audited first: no CR anywhere (this repo is LF-only, and Git for Windows sets
core.autocrlf=true system-wide, which the GitHub Windows runner inherits), no
"C3 82 C2 A0" (a U+00A0 that some tool decoded as cp1252 and re-encoded), valid
UTF-8, and every CSP/substitution placeholder present exactly once.
"""

import hashlib
import os
import re
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# name in C  ->  path in the repo
RESOURCES = [
    ("viewer_html", "Resources/viewer.html"),
    ("marked_js", "Resources/marked.min.js"),
    ("smoke_js", "Scripts/smoke.js"),
    ("security_smoke_js", "Scripts/security-smoke.js"),
    ("fidelity_smoke_js", "Scripts/fidelity-smoke.js"),
    ("sample_md", "sample.md"),
    ("hostile_md", "Scripts/fixtures/hostile.md"),
    ("fidelity_md", "Scripts/fixtures/fidelity.md"),
    # The expected serialization of sample.md. Embedded so --selftest can run the
    # same golden comparison CI runs on macOS and Blink, without needing the repo.
    ("golden_sample_md", "Scripts/fixtures/golden-sample.md"),
]

PER_LINE = 16

# The shell substitutes these by byte replacement at load time, exactly as
# -loadTemplateHTML does on macOS. If one is renamed the replace quietly does
# nothing: the CSP then carries the literal comment instead of a nonce, no inline
# script runs, and the window comes up blank with the error only in a devtools
# console nobody on the owner's machine can open. Cheaper to fail here.
PLACEHOLDERS = [
    b"/*__MARKED_JS__*/",
    b"/*__INITIAL__*/",
    b'nonce="/*__CSP_NONCE__*/"',
    b"'/*__CSP_SCRIPT__*/'",
    b"'/*__CSP_STYLE__*/'",
]

# UTF-8 for U+00A0 (C2 A0) decoded as cp1252 and re-encoded as UTF-8.
MOJIBAKE = b"\xc3\x82\xc2\xa0"


def audit(rel, data):
    """Byte-level facts about a source. Fatal on the two corruptions that are
    invisible on macOS and only bite on Windows."""
    if b"\r" in data:
        sys.stderr.write(
            f"FAIL  {rel}: contains {data.count(chr(13).encode())} CR bytes.\n"
            "      Every file here is authored LF-only, so this checkout translated\n"
            "      line endings - almost certainly Git for Windows with\n"
            "      core.autocrlf=true. Embedding it would ship a viewer.html that\n"
            "      differs from the one macOS ships, byte for byte, and the typing\n"
            "      rules would fail on Windows only. Fix the checkout, not the file:\n"
            "        git config --global core.autocrlf false\n"
            "        git rm --cached -r . && git reset --hard\n"
            "      and keep a .gitattributes containing:  * -text\n")
        return None
    if MOJIBAKE in data:
        sys.stderr.write(
            f"FAIL  {rel}: contains the bytes C3 82 C2 A0.\n"
            "      That is a U+00A0 decoded as cp1252 and re-encoded as UTF-8 -\n"
            "      something read this file as text with a locale codec. The\n"
            "      invisible characters here are load-bearing (CLAUDE.md rule 7).\n")
        return None
    try:
        data.decode("utf-8")
    except UnicodeDecodeError as e:
        sys.stderr.write(f"FAIL  {rel}: not valid UTF-8 ({e}).\n")
        return None
    return {
        "bytes": len(data),
        "lines": data.count(b"\n"),
        # Counted, not enforced: these are the characters rule 7 is about, and a
        # change in the count is exactly what the owner needs to see in the log.
        "nbsp": data.count(b"\xc2\xa0"),      # U+00A0
        "zwsp": data.count(b"\xe2\x80\x8b"),  # U+200B
        "wj": data.count(b"\xe2\x81\xa0"),    # U+2060, rule 30's hard-break joiner
        "pua": data.count(b"\xee\x80\x80") + data.count(b"\xee\x80\x81"),  # U+E000/E001
    }


def emit_array(name, data):
    lines = [f"static const unsigned char glyph_{name}_data[] = {{"]
    for i in range(0, len(data), PER_LINE):
        chunk = data[i:i + PER_LINE]
        lines.append("    " + ",".join(f"0x{b:02x}" for b in chunk) + ",")
    lines.append("};")
    # A separate length constant, because the array is NOT null-terminated and a
    # note is perfectly entitled to contain a zero byte.
    lines.append(f"static const unsigned long glyph_{name}_len = {len(data)}UL;")
    return "\n".join(lines)


def main():
    if len(sys.argv) != 2:
        print(__doc__.strip())
        return 2
    out_path = sys.argv[1]

    blobs = []
    audits = {}
    clean = True
    for name, rel in RESOURCES:
        path = os.path.join(HERE, rel)
        if not os.path.exists(path):
            print(f"missing resource: {rel}", file=sys.stderr)
            return 1
        with open(path, "rb") as f:            # binary, always
            data = f.read()
        info = audit(rel, data)
        if info is None:
            clean = False
            continue
        audits[rel] = info
        blobs.append((name, rel, data, hashlib.sha256(data).hexdigest()))
    if not clean:
        print("source audit FAILED; nothing written", file=sys.stderr)
        return 1

    # The census goes in the log on every build. Three identical censuses in the
    # macOS, Linux and Windows logs is the visible proof of constraint 3.
    print(f"  {'source':<34}{'bytes':>8}{'lines':>7}{'nbsp':>6}{'zwsp':>6}{'wj':>4}{'pua':>5}  sha256")
    for name, rel, data, digest in blobs:
        i = audits[rel]
        print(f"  {rel:<34}{i['bytes']:>8}{i['lines']:>7}{i['nbsp']:>6}{i['zwsp']:>6}"
              f"{i['wj']:>4}{i['pua']:>5}  {digest[:16]}")

    viewer = dict((rel, data) for _, rel, data, _ in blobs)["Resources/viewer.html"]
    for ph in PLACEHOLDERS:
        n = viewer.count(ph)
        if n != 1:
            print(f"FAIL  Resources/viewer.html contains {ph.decode()} {n} times, expected 1.\n"
                  "      The shell replaces these bytes at load time. Missing means no\n"
                  "      script runs and the window is blank; duplicated means only the\n"
                  "      first is replaced. Update shell/glyph.cc and PLACEHOLDERS together.",
                  file=sys.stderr)
            return 1

    parts = [
        "// Generated by Scripts/embed-resources.py - do not edit.",
        "// Regenerate after ANY change to Resources/ or the smoke scripts.",
        "#ifndef GLYPH_RESOURCES_H",
        "#define GLYPH_RESOURCES_H",
        "",
    ]
    for name, rel, data, digest in blobs:
        parts.append(f"// {rel}: {len(data)} bytes, sha256 {digest[:16]}")
        parts.append(emit_array(name, data))
        parts.append("")

    # A name->blob table so the shell can look a resource up without a chain of ifs.
    parts.append("typedef struct { const char *name; const unsigned char *data; unsigned long len; } glyph_resource_t;")
    parts.append("static const glyph_resource_t glyph_resources[] = {")
    for name, rel, data, digest in blobs:
        parts.append(f'    {{"{name}", glyph_{name}_data, glyph_{name}_len}},')
    parts.append("    {0, 0, 0},")
    parts.append("};")
    parts.append("")
    parts.append("#endif  // GLYPH_RESOURCES_H")

    text = "\n".join(parts) + "\n"
    # The header itself stays pure ASCII: the resource BYTES are hex, and MSVC
    # reads source in the machine's codepage unless told otherwise, so a stray
    # non-ASCII character in a comment is a portability bug waiting to happen.
    non_ascii = [c for c in text if ord(c) > 127]
    if non_ascii:
        print(f"generated header is not ASCII: {non_ascii[:5]}", file=sys.stderr)
        return 1
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "wb") as f:            # binary again: no newline translation
        f.write(text.encode("ascii"))

    # The self-check. Parse the generated header back into bytes and prove each
    # blob still hashes to what came off disk. Without this the script would
    # "succeed" while writing subtly wrong bytes, which is the whole failure
    # mode it exists to prevent.
    with open(out_path, "rb") as f:
        generated = f.read().decode("ascii")
    ok = True
    for name, rel, data, digest in blobs:
        m = re.search(
            r"glyph_" + re.escape(name) + r"_data\[\] = \{(.*?)\n\};",
            generated, re.S)
        if not m:
            print(f"FAIL  {rel}: array not found in output", file=sys.stderr)
            ok = False
            continue
        got = bytes(int(h, 16) for h in re.findall(r"0x([0-9a-f]{2})", m.group(1)))
        got_digest = hashlib.sha256(got).hexdigest()
        length = int(re.search(
            r"glyph_" + re.escape(name) + r"_len = (\d+)UL", generated).group(1))
        if got_digest != digest or len(got) != len(data) or length != len(data):
            print(f"FAIL  {rel}: {len(data)} bytes in, {len(got)} out "
                  f"({digest[:12]} vs {got_digest[:12]})", file=sys.stderr)
            ok = False
        else:
            odd = sum(1 for b in data if b > 127)
            note = f", {odd} non-ascii preserved" if odd else ""
            print(f"  ok  {rel:34} {len(data):7} bytes{note}")

    if not ok:
        os.remove(out_path)
        print("resource embedding FAILED; output removed", file=sys.stderr)
        return 1
    total = sum(len(d) for _, _, d, _ in blobs)
    print(f"wrote {out_path}: {len(blobs)} resources, {total} bytes verified byte-exact")
    return 0


if __name__ == "__main__":
    sys.exit(main())
