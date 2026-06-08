"""
Generate sample clinical trial site invoice PDFs for the take-home test.
Run from repo root: pip install reportlab && python scripts/generate_sample_invoices.py
"""
import os
from decimal import Decimal
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "sample-invoices")
os.makedirs(OUTPUT_DIR, exist_ok=True)


def add_header(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica-Bold", 10)
    canvas.drawString(inch, letter[1] - 0.5 * inch, "Clinical Trial Site Invoice")
    canvas.restoreState()


def write_invoice(filename, invoice_number, invoice_date, site_name, site_address, site_city_state_zip, pi_name, sponsor_name, protocol_number, study_name, line_items):
    path = os.path.join(OUTPUT_DIR, filename)
    doc = SimpleDocTemplate(path, pagesize=letter, topMargin=0.75 * inch, bottomMargin=0.75 * inch)
    styles = getSampleStyleSheet()
    story = []

    story.append(Paragraph(f"<b>Invoice #:</b> {invoice_number} &nbsp;&nbsp;&nbsp; <b>Date:</b> {invoice_date}", styles["Normal"]))
    story.append(Spacer(1, 0.2 * inch))
    story.append(Paragraph(f"<b>From:</b> {site_name}", styles["Normal"]))
    story.append(Paragraph(site_address, styles["Normal"]))
    story.append(Paragraph(site_city_state_zip, styles["Normal"]))
    story.append(Paragraph(f"Principal Investigator: {pi_name}", styles["Normal"]))
    story.append(Spacer(1, 0.3 * inch))

    story.append(Paragraph(f"<b>Study:</b> {study_name}", styles["Normal"]))
    story.append(Paragraph(f"<b>Protocol:</b> {protocol_number}", styles["Normal"]))
    story.append(Paragraph(f"<b>Sponsor:</b> {sponsor_name}", styles["Normal"]))
    story.append(Spacer(1, 0.4 * inch))

    story.append(Paragraph("Invoice Line Items", styles["Heading2"]))
    story.append(Spacer(1, 0.15 * inch))

    data = [["Description", "Qty", "Unit Price", "Amount"]]
    total = Decimal("0")
    for desc, qty, unit_price in line_items:
        up = Decimal(str(unit_price))
        amt = up * int(qty)
        total += amt
        data.append([desc, str(qty), f"${float(up):,.2f}", f"${amt:,.2f}"])
    data.append(["", "", "Total:", f"${total:,.2f}"])

    t = Table(data, colWidths=[3.5 * inch, 0.6 * inch, 1.0 * inch, 1.2 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.grey),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.whitesmoke),
        ("ALIGN", (0, 0), (-1, -1), "LEFT"),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 10),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 12),
        ("BACKGROUND", (0, 1), (-1, -2), colors.beige),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
    ]))
    story.append(t)
    doc.build(story, onFirstPage=add_header, onLaterPages=add_header)
    print(f"Wrote {path}")


def main():
    # Simple: 5 line items, light wording variation (Contoso / CATALYST Trial). Happy path.
    write_invoice(
        "simple-invoice.pdf",
        invoice_number="INV-2024-001",
        invoice_date="2024-03-15",
        site_name="Willow Creek Clinical Research Center",
        site_address="123 Research Way",
        site_city_state_zip="Portland, OR 97201 USA",
        pi_name="Dr. Alex Morgan",
        sponsor_name="Contoso Therapeutics",
        protocol_number="CON-CAT-2024-101",
        study_name="CATALYST Trial",
        line_items=[
            ("Site Management Fee", 1, "400.00"),
            ("Screening Visit", 2, "480.00"),
            ("Baseline Visit", 1, "550.00"),
            ("Complete Blood Count", 1, "95.00"),
            ("IV Infusion Administration", 1, "225.00"),
        ],
    )

    # Medium: 11 line items, fuzzy wording + one price mismatch (Northwind / LUMIN-2024).
    write_invoice(
        "medium-invoice.pdf",
        invoice_number="INV-2024-042",
        invoice_date="2024-06-20",
        site_name="Harborview Medical Institute",
        site_address="456 Lake Shore Drive",
        site_city_state_zip="Chicago, IL 60611 USA",
        pi_name="Dr. Jordan Blake",
        sponsor_name="Northwind Pharma",
        protocol_number="NWD-LUM-2024-001",
        study_name="LUMIN-2024",
        line_items=[
            ("Site Administration Fee", 1, "350.00"),
            ("Screening Visit", 3, "450.00"),
            ("Baseline Assessment", 2, "525.00"),
            ("Week 4 Follow-up", 2, "475.00"),
            ("Week 8 Follow-up", 2, "475.00"),
            ("12-Lead ECG", 5, "85.00"),
            ("CBC", 4, "95.00"),
            ("CMP", 4, "110.00"),
            ("Drug Infusion", 2, "200.00"),
            ("PK Blood Draw", 4, "75.00"),
            ("IRB/Ethics Fees", 1, "550.00"),
        ],
    )

    # Large: 27 line items, fuzzy/ambiguous/unmatched + price mismatch (Northwind / LUMIN-2024).
    write_invoice(
        "large-invoice.pdf",
        invoice_number="INV-2024-108",
        invoice_date="2024-09-12",
        site_name="Highland Ridge Hospital - Research Unit",
        site_address="789 Mountain View Blvd",
        site_city_state_zip="Denver, CO 80202 USA",
        pi_name="Dr. Taylor Reed",
        sponsor_name="Northwind Pharma",
        protocol_number="NWD-LUM-2024-001",
        study_name="LUMIN-2024",
        line_items=[
            ("Site Admin", 1, "350.00"),
            ("Screening Visit", 5, "450.00"),
            ("Baseline Visit", 4, "525.00"),
            ("Wk 4 Visit", 4, "475.00"),
            ("Wk 8 Visit", 4, "475.00"),
            ("Week 12 Visit", 4, "500.00"),
            ("Week 16 Visit", 4, "500.00"),
            ("Wk 24 Visit", 3, "525.00"),
            ("End of Study Visit", 2, "550.00"),
            ("ECG", 12, "85.00"),
            ("Vitals", 20, "45.00"),
            ("Physical Exam", 10, "120.00"),
            ("IV Drug Administration", 8, "200.00"),
            ("Pharmacokinetic Sampling", 16, "75.00"),
            ("CBC w/ Differential", 10, "95.00"),
            ("Comprehensive Metabolic Panel", 10, "110.00"),
            ("UA", 8, "55.00"),
            ("Hepatic Function Panel", 8, "88.00"),
            ("Lipid Panel", 6, "78.00"),
            ("CT Scan - Chest/Abdomen", 2, "475.00"),
            ("IRB Annual Maintenance", 1, "500.00"),
            ("Drug Shipping (cold chain)", 3, "125.00"),
            ("Lab Supplies", 10, "42.00"),
            ("Sample Transport", 8, "58.00"),
            ("Parking Reimbursement", 15, "25.00"),
            ("Patient Stipend", 12, "75.00"),
            ("Translator Services", 3, "150.00"),
        ],
    )


    # Metadata mismatch: 7 line items, easy matching BUT metadata fields are wrong/fuzzy.
    # Actual target: Northwind Pharma / VERITAS (study_id=2), Prairie Field Research Group (site_id=6).
    # Forces the user to manually select/correct metadata before line-item matching can proceed.
    write_invoice(
        "mismatched-metadata-invoice.pdf",
        invoice_number="INV-2024-077",
        invoice_date="2024-07-30",
        site_name="Prairie Clinical Research",
        site_address="1200 Prairie View Road",
        site_city_state_zip="Kansas City, MO 64108 USA",
        pi_name="Dr. Riley H. Foster",
        sponsor_name="Northwind Pharmaceuticals Inc.",
        protocol_number="NWD-VER-2024-002",
        study_name="VERITAS Phase 2 Study",
        line_items=[
            ("Site Admin Fee", 1, "325.00"),
            ("Screening", 2, "425.00"),
            ("Baseline", 2, "500.00"),
            ("Month 3 Follow-up", 1, "475.00"),
            ("ECG", 3, "80.00"),
            ("CBC", 2, "90.00"),
            ("Lipid Profile", 2, "75.00"),
        ],
    )


if __name__ == "__main__":
    main()
