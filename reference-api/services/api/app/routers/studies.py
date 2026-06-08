from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Study
from app.schemas import StudyResponse, PaginatedResponse

router = APIRouter(prefix="/studies", tags=["studies"])

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100


@router.get("", response_model=PaginatedResponse)
def list_studies(
    page: int = Query(1, ge=1),
    page_size: int = Query(DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
    sponsor_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    q = db.query(Study)
    if sponsor_id is not None:
        q = q.filter(Study.sponsor_id == sponsor_id)
    total = q.count()
    items = q.offset((page - 1) * page_size).limit(page_size).all()
    pages = (total + page_size - 1) // page_size if total else 1
    return PaginatedResponse(
        items=[StudyResponse.model_validate(x) for x in items],
        total=total,
        page=page,
        page_size=page_size,
        pages=pages,
    )


@router.get("/{id}", response_model=StudyResponse)
def get_study(id: int, db: Session = Depends(get_db)):
    study = db.query(Study).filter(Study.id == id).first()
    if not study:
        raise HTTPException(status_code=404, detail="Study not found")
    return StudyResponse.model_validate(study)
