"""
Seed the reference database with sponsors, studies, sites, study_sites, and catalog_items.
Run after DB is up and before starting the API. Idempotent: truncates and re-seeds.
"""
import json
import os
import sys

# Ensure app is importable when run as python -m seed.seed from /app
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text
from app.database import engine, Base
from app.models import Sponsor, Study, Site, StudySite, CatalogItem

SEED_DATA_DIR = os.path.join(os.path.dirname(__file__), "data")


def load_json(filename: str) -> list:
    path = os.path.join(SEED_DATA_DIR, filename)
    with open(path, "r") as f:
        return json.load(f)


def seed():
    print("Creating tables...")
    Base.metadata.create_all(bind=engine)

    with engine.connect() as conn:
        # Truncate in reverse dependency order
        print("Truncating existing data...")
        conn.execute(text("TRUNCATE catalog_items, study_sites, studies, sites, sponsors RESTART IDENTITY CASCADE"))
        conn.commit()

    from app.database import SessionLocal
    db = SessionLocal()
    try:
        # Insert in dependency order
        for row in load_json("sponsors.json"):
            db.add(Sponsor(**row))
        db.commit()
        print("Seeded sponsors")

        for row in load_json("studies.json"):
            db.add(Study(**row))
        db.commit()
        print("Seeded studies")

        for row in load_json("sites.json"):
            db.add(Site(**row))
        db.commit()
        print("Seeded sites")

        for row in load_json("study_sites.json"):
            db.add(StudySite(**row))
        db.commit()
        print("Seeded study_sites")

        for row in load_json("catalog_items.json"):
            db.add(CatalogItem(**row))
        db.commit()
        print("Seeded catalog_items")
    finally:
        db.close()

    # Reset sequences so future inserts get correct IDs (Postgres)
    with engine.connect() as conn:
        for table in ("sponsors", "studies", "sites", "study_sites", "catalog_items"):
            conn.execute(text(f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), (SELECT COALESCE(MAX(id), 1) FROM {table}))"))
        conn.commit()

    print("Seed complete.")


if __name__ == "__main__":
    seed()
