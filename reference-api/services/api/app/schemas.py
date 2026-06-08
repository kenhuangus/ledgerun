from decimal import Decimal
from typing import Generic, TypeVar
from pydantic import BaseModel, ConfigDict


class SponsorBase(BaseModel):
    name: str
    code: str


class SponsorResponse(SponsorBase):
    id: int
    model_config = ConfigDict(from_attributes=True)


class StudyBase(BaseModel):
    sponsor_id: int
    name: str
    protocol_number: str
    phase: str | None = None
    therapeutic_area: str | None = None


class StudyResponse(StudyBase):
    id: int
    model_config = ConfigDict(from_attributes=True)


class StudyResponseWithSponsor(StudyResponse):
    sponsor: SponsorResponse | None = None


class SiteBase(BaseModel):
    name: str
    city: str | None = None
    state: str | None = None
    country: str | None = None
    pi_name: str | None = None


class SiteResponse(SiteBase):
    id: int
    model_config = ConfigDict(from_attributes=True)


class StudySiteBase(BaseModel):
    study_id: int
    site_id: int
    status: str | None = None


class StudySiteResponse(StudySiteBase):
    id: int
    model_config = ConfigDict(from_attributes=True)


class StudySiteResponseWithRelations(StudySiteResponse):
    study: StudyResponse | None = None
    site: SiteResponse | None = None


class CatalogItemBase(BaseModel):
    sponsor_id: int
    study_id: int
    item_code: str
    description: str
    category: str | None = None
    unit_price: Decimal | None = None


class CatalogItemResponse(CatalogItemBase):
    id: int
    model_config = ConfigDict(from_attributes=True)


T = TypeVar("T")


class PaginatedResponse(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int
    pages: int
