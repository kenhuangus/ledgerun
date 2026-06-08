from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import CatalogItem
from app.schemas import CatalogItemResponse, PaginatedResponse

router = APIRouter(prefix="/catalog-items", tags=["catalog-items"])

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200


@router.get("", response_model=PaginatedResponse)
def list_catalog_items(
    page: int = Query(1, ge=1),
    page_size: int = Query(DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
    sponsor_id: int | None = Query(None),
    study_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    q = db.query(CatalogItem)
    if sponsor_id is not None:
        q = q.filter(CatalogItem.sponsor_id == sponsor_id)
    if study_id is not None:
        q = q.filter(CatalogItem.study_id == study_id)
    total = q.count()
    items = q.offset((page - 1) * page_size).limit(page_size).all()
    pages = (total + page_size - 1) // page_size if total else 1
    return PaginatedResponse(
        items=[CatalogItemResponse.model_validate(x) for x in items],
        total=total,
        page=page,
        page_size=page_size,
        pages=pages,
    )


@router.get("/{id}", response_model=CatalogItemResponse)
def get_catalog_item(id: int, db: Session = Depends(get_db)):
    item = db.query(CatalogItem).filter(CatalogItem.id == id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Catalog item not found")
    return CatalogItemResponse.model_validate(item)
