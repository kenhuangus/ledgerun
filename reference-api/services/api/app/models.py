from sqlalchemy import Column, Integer, String, Numeric, ForeignKey
from sqlalchemy.orm import relationship

from .database import Base


class Sponsor(Base):
    __tablename__ = "sponsors"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    code = Column(String(64), nullable=False, unique=True)

    studies = relationship("Study", back_populates="sponsor")
    catalog_items = relationship("CatalogItem", back_populates="sponsor")


class Study(Base):
    __tablename__ = "studies"

    id = Column(Integer, primary_key=True, index=True)
    sponsor_id = Column(Integer, ForeignKey("sponsors.id"), nullable=False)
    name = Column(String(255), nullable=False)
    protocol_number = Column(String(64), nullable=False)
    phase = Column(String(64), nullable=True)
    therapeutic_area = Column(String(255), nullable=True)

    sponsor = relationship("Sponsor", back_populates="studies")
    study_sites = relationship("StudySite", back_populates="study")
    catalog_items = relationship("CatalogItem", back_populates="study")


class Site(Base):
    __tablename__ = "sites"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    city = Column(String(128), nullable=True)
    state = Column(String(64), nullable=True)
    country = Column(String(128), nullable=True)
    pi_name = Column(String(255), nullable=True)

    study_sites = relationship("StudySite", back_populates="site")


class StudySite(Base):
    __tablename__ = "study_sites"

    id = Column(Integer, primary_key=True, index=True)
    study_id = Column(Integer, ForeignKey("studies.id"), nullable=False)
    site_id = Column(Integer, ForeignKey("sites.id"), nullable=False)
    status = Column(String(64), nullable=True)

    study = relationship("Study", back_populates="study_sites")
    site = relationship("Site", back_populates="study_sites")


class CatalogItem(Base):
    __tablename__ = "catalog_items"

    id = Column(Integer, primary_key=True, index=True)
    sponsor_id = Column(Integer, ForeignKey("sponsors.id"), nullable=False)
    study_id = Column(Integer, ForeignKey("studies.id"), nullable=False)
    item_code = Column(String(64), nullable=False)
    description = Column(String(512), nullable=False)
    category = Column(String(128), nullable=True)
    unit_price = Column(Numeric(12, 2), nullable=True)

    sponsor = relationship("Sponsor", back_populates="catalog_items")
    study = relationship("Study", back_populates="catalog_items")
