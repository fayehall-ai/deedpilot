#!/usr/bin/env python3
"""Dump first sheet rows of an xlsx as JSON (stdlib only)."""
import json
import sys
import zipfile
from xml.etree import ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
path = sys.argv[1]
z = zipfile.ZipFile(path)
ss: list[str] = []
if "xl/sharedStrings.xml" in z.namelist():
    root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    for si in root.findall(f"{NS}si"):
        texts = [t.text or "" for t in si.iter(f"{NS}t")]
        ss.append("".join(texts))
root = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
rows = []
for row in root.findall(f".//{NS}sheetData/{NS}row"):
    cells = []
    for c in row.findall(f"{NS}c"):
        t = c.get("t")
        v = c.find(f"{NS}v")
        val = v.text if v is not None else ""
        if t == "s" and val.isdigit():
            val = ss[int(val)]
        cells.append(val)
    if any(cells):
        rows.append(cells)
print(json.dumps(rows))
