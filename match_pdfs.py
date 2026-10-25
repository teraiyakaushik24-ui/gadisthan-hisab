import os
import re
import sys
from pathlib import Path

# PDF handling libraries
# For searchable PDFs (text-based), we use pdfplumber.
# For scanned PDFs (image-based), we fall back to OCR using pdf2image + pytesseract.

try:
    import pdfplumber
except ImportError:
    raise ImportError("pdfplumber not installed. Install with 'pip install pdfplumber'.")

try:
    from pdf2image import convert_from_path
except ImportError:
    raise ImportError("pdf2image not installed. Install with 'pip install pdf2image'.")

try:
    import pytesseract
except ImportError:
    raise ImportError("pytesseract not installed. Install with 'pip install pytesseract' and ensure Tesseract OCR executable is in PATH.")

import pandas as pd

# ------------------------------------------------------------
# Helper functions
# ------------------------------------------------------------

def extract_text_from_pdf(pdf_path: Path) -> str:
    """Extract raw text from a PDF.
    If the PDF is searchable, use pdfplumber; otherwise use OCR.
    """
    try:
        with pdfplumber.open(pdf_path) as pdf:
            # Check if any page contains extractable text
            for page in pdf.pages:
                txt = page.extract_text()
                if txt and txt.strip():
                    # Text based PDF – concatenate all pages
                    return "\n".join(p.extract_text() or "" for p in pdf.pages)
    except Exception as e:
        print(f"pdfplumber failed ({e}), falling back to OCR.")

    # OCR fallback – convert each page to image and run pytesseract
    images = convert_from_path(str(pdf_path))
    ocr_text = []
    for i, img in enumerate(images, start=1):
        txt = pytesseract.image_to_string(img)
        ocr_text.append(txt)
    return "\n".join(ocr_text)


def parse_transactions(text: str) -> pd.DataFrame:
    """Parse dates and amounts from raw PDF text.
    Returns a DataFrame with columns ['date', 'amount', 'raw'].
    This function uses simple regular expressions and can be customized
    for different statement layouts.
    """
    # Common date patterns: DD/MM/YYYY, YYYY-MM-DD, etc.
    date_pattern = r"(\d{2}[\/\-]\d{2}[\/\-]\d{4}|\d{4}[\/\-]\d{2}[\/\-]\d{2})"
    # Amount pattern – numbers with optional commas and two decimal places
    amount_pattern = r"(?<![\d.])(?:\$|₹)?\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?(?!\d)"

    records = []
    lines = text.splitlines()
    for line in lines:
        line = line.strip()
        if not line:
            continue
        date_match = re.search(date_pattern, line)
        amount_match = re.search(amount_pattern, line)
        if date_match and amount_match:
            date = date_match.group(0)
            amount = amount_match.group(0).replace(',', '')
            # Normalise amount – keep only digits and decimal point
            amount = re.sub(r"[^0-9.]", "", amount)
            try:
                amount_val = float(amount)
            except ValueError:
                continue
            records.append({"date": date, "amount": amount_val, "raw": line})
    return pd.DataFrame(records)


def match_transactions(df_bank: pd.DataFrame, df_donation: pd.DataFrame) -> pd.DataFrame:
    """Match transactions based on both date and amount.
    A simple inner join on date and amount (allowing a tolerance for amount).
    """
    # Sometimes amounts differ by a few paise/cent – allow small tolerance
    tolerance = 0.01
    merged = pd.merge(
        df_bank,
        df_donation,
        on="date",
        suffixes=("_bank", "_donation"),
        how="inner",
    )
    # Filter rows where amounts are within tolerance
    matched = merged[abs(merged["amount_bank"] - merged["amount_donation"]) <= tolerance]
    return matched


def main(bank_pdf: str, donation_pdf: str, output_csv: str = "matched.csv"):
    bank_path = Path(bank_pdf)
    donation_path = Path(donation_pdf)
    if not bank_path.is_file() or not donation_path.is_file():
        sys.exit("Both PDF files must exist.")

    print("Extracting text from bank statement …")
    bank_text = extract_text_from_pdf(bank_path)
    print("Extracting text from donation list …")
    donation_text = extract_text_from_pdf(donation_path)

    print("Parsing transactions …")
    df_bank = parse_transactions(bank_text)
    df_donation = parse_transactions(donation_text)
    if df_bank.empty or df_donation.empty:
        sys.exit("Could not find any date‑amount pairs in one of the PDFs.")

    print(f"Bank records: {len(df_bank)}; Donation records: {len(df_donation)}")
    matched = match_transactions(df_bank, df_donation)
    print(f"Matched rows: {len(matched)}")
    matched.to_csv(output_csv, index=False)
    print(f"Matched data saved to {output_csv}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python match_pdfs.py <bank_statement.pdf> <donation_list.pdf> [output.csv]")
        sys.exit(1)
    out = sys.argv[3] if len(sys.argv) > 3 else "matched.csv"
    main(sys.argv[1], sys.argv[2], out)
