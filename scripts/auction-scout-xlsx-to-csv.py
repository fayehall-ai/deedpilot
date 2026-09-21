#!/usr/bin/env python3
"""
Convert an Auction Scout xlsx to CSV format compatible with import-auction-csv.ts.

Usage:
    python3 scripts/auction-scout-xlsx-to-csv.py [path/to/report.xlsx]

If no path is given, uses the latest xlsx in data/auction-scout/.
Output goes to downloads/auction-scout-import.csv.
"""
import csv
import os
import sys
from datetime import datetime
from pathlib import Path

try:
    import openpyxl
except ImportError:
    print("openpyxl not installed. Run: pip install openpyxl", file=sys.stderr)
    sys.exit(1)

STATE_FULL = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
    "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
    "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
    "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi",
    "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
    "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
    "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
    "WI": "Wisconsin", "WY": "Wyoming", "DC": "District of Columbia",
}

SCOUT_DIR = Path("data/auction-scout")
DOWNLOADS_DIR = Path("downloads")


def find_latest_xlsx() -> Path | None:
    if not SCOUT_DIR.exists():
        return None
    files = sorted(SCOUT_DIR.glob("*.xlsx"), reverse=True)
    return files[0] if files else None


def cell_value(cell) -> str:
    """Extract string value from an openpyxl cell."""
    if cell.value is None:
        return ""
    if isinstance(cell.value, datetime):
        return cell.value.strftime("%Y-%m-%d")
    return str(cell.value).strip()


def main():
    # Find xlsx file
    if len(sys.argv) > 1:
        xlsx_path = Path(sys.argv[1])
    else:
        xlsx_path = find_latest_xlsx()

    if not xlsx_path or not xlsx_path.exists():
        print(
            f"No xlsx file found. Either:\n"
            f"  - Place an Auction Scout xlsx in {SCOUT_DIR}/\n"
            f"  - Or pass a path as argument",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"Reading: {xlsx_path}")
    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)

    if "Auction Scout" not in wb.sheetnames:
        print(f'No "Auction Scout" sheet found.', file=sys.stderr)
        print(f"Available sheets: {', '.join(wb.sheetnames)}", file=sys.stderr)
        sys.exit(1)

    ws = wb["Auction Scout"]
    print(f'Found "Auction Scout" sheet')

    # Parse rows
    # XLSX columns (1-indexed):
    #   A(1): Weeks to Auction
    #   B(2): Sale Date
    #   C(3): State (abbrev)
    #   D(4): County / Jurisdiction
    #   E(5): Auction Type
    #   F(6): Sale Method / Location
    #   G(7): Sale Address
    #   H(8): Parcels
    #   I(9): Aggregate Sale Amount
    #   J(10): Contact
    #   K(11): Phone
    #   L(12): Email
    #   M(13): Email Domain
    #   N(14): Primary Source / Web Address
    #   O(15): Auction Property List / Download Link
    #
    # CSV layout for import-auction-csv.ts (0-indexed):
    #   0: County
    #   1: State (full name)
    #   2: Sale Date
    #   3: Start Time
    #   7: Venue
    #   8: Contact Name
    #   9: Phone
    #   10: Fax
    #   11: Email
    #   17: Property List Link

    csv_rows = []
    by_state: dict[str, int] = {}

    for row_idx, row in enumerate(ws.iter_rows(min_row=2), start=2):
        # Extract values (row is a tuple of cells)
        state_abbr = cell_value(row[2])  # C - State
        county = cell_value(row[3])  # D - County
        sale_date = cell_value(row[1])  # B - Sale Date
        sale_method = cell_value(row[5])  # F - Sale Method/Location
        sale_address = cell_value(row[6])  # G - Sale Address
        contact = cell_value(row[9])  # J - Contact
        phone = cell_value(row[10])  # K - Phone
        email = cell_value(row[11])  # L - Email
        property_list = cell_value(row[14]) if len(row) > 14 else ""  # O - Property List

        if not county or not state_abbr:
            continue

        state_full = STATE_FULL.get(state_abbr, state_abbr)
        venue = sale_address or sale_method

        # Build row matching import-auction-csv.ts column expectations
        csv_row = [
            county,        # 0: County
            state_full,    # 1: State
            sale_date,     # 2: Sale Date
            "",            # 3: Start Time
            "",            # 4
            "",            # 5
            "",            # 6
            venue,         # 7: Venue
            contact,       # 8: Contact
            phone,         # 9: Phone
            "",            # 10: Fax
            email,         # 11: Email
            "",            # 12
            "",            # 13
            "",            # 14
            "",            # 15
            "",            # 16
            property_list, # 17: Property List
        ]
        csv_rows.append(csv_row)
        by_state[state_full] = by_state.get(state_full, 0) + 1

    wb.close()
    print(f"Parsed {len(csv_rows)} auction rows")

    # Write CSV
    DOWNLOADS_DIR.mkdir(exist_ok=True)
    csv_path = DOWNLOADS_DIR / "auction-scout-import.csv"
    with open(csv_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerows(csv_rows)

    print(f"Wrote {csv_path}")

    # Summary by state
    print("\nAuctions by state:")
    for state, count in sorted(by_state.items(), key=lambda x: -x[1]):
        print(f"  {state:20} {count}")

    print(f"\nNext step: npx tsx scripts/import-auction-csv.ts [--apply]")


if __name__ == "__main__":
    main()
