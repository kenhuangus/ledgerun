from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.database import engine, Base
from app.routers import sponsors, studies, sites, study_sites, catalog_items

Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="Clinical Trials Reference Data API",
    description="Read-only API for sponsors, studies, sites, study-sites, and catalog items.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sponsors.router, prefix="/api/v1")
app.include_router(studies.router, prefix="/api/v1")
app.include_router(sites.router, prefix="/api/v1")
app.include_router(study_sites.router, prefix="/api/v1")
app.include_router(catalog_items.router, prefix="/api/v1")


@app.get("/health")
def health():
    return {"status": "ok"}
