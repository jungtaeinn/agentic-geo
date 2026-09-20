"""OCR parsing, layout, metric, and slicing primitives."""

from typing import TYPE_CHECKING, Any

from .blocks import parse_ocr_block_sections
from .layout import parse_image_ocr_payload_text

if TYPE_CHECKING:
    from .evidence import assemble_image_ocr_evidence, extract_image_ocr_evidence

__all__ = [
    "assemble_image_ocr_evidence",
    "extract_image_ocr_evidence",
    "parse_image_ocr_payload_text",
    "parse_ocr_block_sections",
]


def __getattr__(name: str) -> Any:
    # Provider adapters import ``ocr.prompt`` during package initialization.
    # Delay the provider-dependent evidence module to avoid a circular import
    # while preserving the historic ``pdp_extractor_agent.ocr`` exports.
    if name in {"assemble_image_ocr_evidence", "extract_image_ocr_evidence"}:
        from .evidence import assemble_image_ocr_evidence, extract_image_ocr_evidence

        return {"assemble_image_ocr_evidence": assemble_image_ocr_evidence, "extract_image_ocr_evidence": extract_image_ocr_evidence}[name]
    raise AttributeError(name)
