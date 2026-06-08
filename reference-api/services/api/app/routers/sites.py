from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Site
from app.schemas import SiteResponse, PaginatedResponse

router = APIRouter(prefix="/sites", tags=["sites"])

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100


@router.get("", response_model=PaginatedResponse)
def list_sites(
    page: int = Query(1, ge=1),
    page_size: int = Query(DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
    db: Session = Depends(get_db),
):
    q = db.query(Site)
    total = q.count()
    items = q.offset((page - 1) * page_size).limit(page_size).all()
    pages = (total + page_size - 1) // page_size if total else 1
    return PaginatedResponse(
        items=[SiteResponse.model_validate(x) for x in items],
        total=total,
        page=page,
        page_size=page_size,
        pages=pages,
    )


@router.get("/{id}", response_model=SiteResponse)
def get_site(id: int, db: Session = Depends(get_db)):
    site = db.query(Site).filter(Site.id == id).first()
    if not site:
        raise HTTPException(status_code=404, detail="Site not found")
    return SiteResponse.model_validate(site)
