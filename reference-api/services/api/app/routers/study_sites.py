from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import StudySite
from app.schemas import StudySiteResponse, PaginatedResponse

router = APIRouter(prefix="/study-sites", tags=["study-sites"])

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100


@router.get("", response_model=PaginatedResponse)
def list_study_sites(
    page: int = Query(1, ge=1),
    page_size: int = Query(DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
    study_id: int | None = Query(None),
    site_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    q = db.query(StudySite)
    if study_id is not None:
        q = q.filter(StudySite.study_id == study_id)
    if site_id is not None:
        q = q.filter(StudySite.site_id == site_id)
    total = q.count()
    items = q.offset((page - 1) * page_size).limit(page_size).all()
    pages = (total + page_size - 1) // page_size if total else 1
    return PaginatedResponse(
        items=[StudySiteResponse.model_validate(x) for x in items],
        total=total,
        page=page,
        page_size=page_size,
        pages=pages,
    )


@router.get("/{id}", response_model=StudySiteResponse)
def get_study_site(id: int, db: Session = Depends(get_db)):
    study_site = db.query(StudySite).filter(StudySite.id == id).first()
    if not study_site:
        raise HTTPException(status_code=404, detail="Study-site not found")
    return StudySiteResponse.model_validate(study_site)
