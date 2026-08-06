#!/usr/bin/env python3
"""
Convert an SRI "Download List" Excel export into a capture file.

SRI's per-county Excel export is richer than the rendered listing cards: it
carries the minimum bid, the owner and the full legal description, none of
which appear on screen. It is also the only practical way to take a large
county — Jefferson Parish LA is 1,638 properties across 182 pages.

The export is produced by the operator's own browser via the site's own
Download List button; nothing here fetches anything. See docs/sri-capture.md.

Usage:
  python3 scripts/sri_xlsx_to_capture.py <file.xlsx> --state LA \\
      --county Jefferson --type "tax lien" [--out data/sri-capture]

Writes <STATE>-<County>-<type>.json in the capture format that
lib/ingest/adapters/sri.ts reads. stdlib only.
"""
import argparse
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def read_rows(path: Path) -> list[list[str]]:
    """First worksheet as rows of strings, resolving the shared-string table."""
    z = zipfile.ZipFile(path)
    shared: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.findall(f"{NS}si"):
            shared.append("".join(t.text or "" for t in si.iter(f"{NS}t")))

    sheet = next(n for n in z.namelist() if re.match(r"xl/worksheets/sheet1\.xml$", n))
    root = ET.fromstring(z.read(sheet))
    rows: list[list[str]] = []
    for row in root.findall(f".//{NS}sheetData/{NS}row"):
        cells: list[str] = []
        for c in row.findall(f"{NS}c"):
            v = c.find(f"{NS}v")
            if c.get("t") == "s" and v is not None:
                cells.append(shared[int(v.text)])
            elif c.get("t") == "inlineStr":
                cells.append("".join(t.text or "" for t in c.iter(f"{NS}t")))
            else:
                cells.append(v.text if v is not None and v.text else "")
        rows.append(cells)
    return rows


def money(raw: str) -> float | None:
    s = re.sub(r"[^\d.]", "", str(raw or ""))
    if not s:
        return None
    # Guard the same malformed-thousands case seen in the Texas notices, where
    # a separator survives as a second decimal point.
    if s.count(".") > 1:
        last = s.rfind(".")
        s = s[:last].replace(".", "") + s[last:]
    try:
        v = float(s)
    except ValueError:
        return None
    return v if v > 0 else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("--state", required=True)
    ap.add_argument("--county", required=True)
    ap.add_argument("--type", default="tax")
    ap.add_argument("--out", default="data/sri-capture")
    a = ap.parse_args()

    rows = read_rows(Path(a.xlsx))
    if not rows:
        print("no rows found", file=sys.stderr)
        return 1

    header = [h.strip() for h in rows[0]]
    idx = {h: i for i, h in enumerate(header)}

    def col(r: list[str], name: str) -> str:
        i = idx.get(name)
        return (r[i].strip() if i is not None and i < len(r) and r[i] else "")

    required = ["Sale Date", "Sale ID", "Property ID", "Minimum Bid"]
    missing = [c for c in required if c not in idx]
    if missing:
        print(f"export is missing expected column(s): {missing}", file=sys.stderr)
        print(f"header was: {header}", file=sys.stderr)
        return 1

    props = []
    skipped = 0
    for r in rows[1:]:
        sale_id = col(r, "Sale ID")
        parcel = col(r, "Property ID")
        if not sale_id and not parcel:
            skipped += 1
            continue
        props.append(
            {
                "addr": col(r, "Property Street"),
                # The export has no city column; the adapter tolerates a blank.
                "city": "",
                "saleId": sale_id,
                "parcel": parcel,
                "date": col(r, "Sale Date"),
                "time": col(r, "Sale Time"),
                "status": "",
                "saleType": a.type.title(),
                "method": col(r, "Sale Location"),
                "minBid": money(col(r, "Minimum Bid")),
                "owner": col(r, "Owner Name"),
                "legal": col(r, "Legal"),
            }
        )

    slug = a.type.replace(" ", "-").lower()
    dest = Path(a.out) / f"{a.state.upper()}-{a.county}-{slug}.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(
        json.dumps(
            {
                "source": "sriservices.com Download List (Excel)",
                "capturedFor": {
                    "state": a.state.upper(),
                    "county": a.county,
                    "saleTypeParam": a.type,
                },
                "properties": props,
            }
        )
        + "\n"
    )

    with_bid = sum(1 for p in props if p["minBid"] is not None)
    with_addr = sum(1 for p in props if p["addr"])
    print(f"wrote {dest}")
    print(f"  {len(props)} properties ({skipped} skipped for no id)")
    print(f"  {with_bid} with minimum bid, {with_addr} with street address")
    print(f"  unique sale ids: {len({p['saleId'] for p in props})}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
