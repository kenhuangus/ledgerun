from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Sponsor
from app.schemas import SponsorResponse, PaginatedResponse

router = APIRouter(prefix="/sponsors", tags=["sponsors"])

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100


@router.get("", response_model=PaginatedResponse)
def list_sponsors(
    page: int = Query(1, ge=1),
    page_size: int = Query(DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
    db: Session = Depends(get_db),
):
    q = db.query(Sponsor)
    total = q.count()
    items = q.offset((page - 1) * page_size).limit(page_size).all()
    pages = (total + page_size - 1) // page_size if total else 1
    return PaginatedResponse(
        items=[SponsorResponse.model_validate(x) for x in items],
        total=total,
        page=page,
        page_size=page_size,
        pages=pages,
    )


@router.get("/{id}", response_model=SponsorResponse)
def get_sponsor(id: int, db: Session = Depends(get_db)):
    sponsor = db.query(Sponsor).filter(Sponsor.id == id).first()
    if not sponsor:
        raise HTTPException(status_code=404, detail="Sponsor not found")
    return SponsorResponse.model_validate(sponsor)
