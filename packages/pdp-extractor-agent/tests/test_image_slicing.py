"""Ports of image header, fragment, and tall-image slicing contracts (11 cases)."""

from __future__ import annotations

import io

import pytest
from PIL import Image

from pdp_extractor_agent.ocr.slicing import (
    parse_slice_fragment,
    prepare_image_ocr_inputs,
    read_image_dimensions,
    slice_display_url,
    strip_slice_fragment,
)


def _png(width: int, height: int) -> bytes:
    image = Image.new("RGB", (width, height), (250, 250, 250))
    stream = io.BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


def _jpeg(width: int, height: int) -> bytes:
    image = Image.new("RGB", (width, height), (250, 250, 250))
    stream = io.BytesIO()
    image.save(stream, format="JPEG")
    return stream.getvalue()


def test_reads_png_dimensions() -> None:
    assert read_image_dimensions(_png(320, 4800)) == {"width": 320, "height": 4800}


def test_reads_jpeg_dimensions() -> None:
    assert read_image_dimensions(_jpeg(200, 900)) == {"width": 200, "height": 900}


def test_reads_gif_dimensions() -> None:
    assert read_image_dimensions(b"GIF89a" + bytes([0x40, 0x01, 0xF4, 0x01, 0, 0, 0, 0])) == {
        "width": 320,
        "height": 500,
    }


def test_rejects_non_image_bytes() -> None:
    assert read_image_dimensions(b"not an image") is None


def test_round_trips_slice_fragment() -> None:
    display = slice_display_url("https://cdn.example/detail.png", 3, 12)
    assert display == "https://cdn.example/detail.png#ocr-slice-3of12"
    assert strip_slice_fragment(display) == "https://cdn.example/detail.png"


def test_preserves_unrelated_fragment() -> None:
    assert strip_slice_fragment("https://cdn.example/detail.png#gallery") == "https://cdn.example/detail.png#gallery"


def test_parses_slice_index_and_count() -> None:
    assert parse_slice_fragment("https://cdn.example/detail.png#ocr-slice-3of7") == {
        "baseUrl": "https://cdn.example/detail.png",
        "sliceIndex": 3,
        "sliceCount": 7,
    }


def test_preserves_url_without_fragment() -> None:
    assert parse_slice_fragment("https://cdn.example/detail.png") == {"baseUrl": "https://cdn.example/detail.png"}


def test_does_not_treat_unrelated_fragment_as_slice() -> None:
    assert parse_slice_fragment("https://cdn.example/detail.png#section-2") == {
        "baseUrl": "https://cdn.example/detail.png#section-2"
    }


@pytest.mark.asyncio
async def test_slices_tall_scroll_image_into_overlapping_vertical_segments() -> None:
    async def fetcher(_: str) -> tuple[int, str, bytes]:
        return 200, "image/png", _png(200, 5000)

    prepared = await prepare_image_ocr_inputs("https://cdn.example/tall.png", fetcher=fetcher)
    assert prepared["sliced"] is True
    assert len(prepared["inputs"]) == 5
    assert prepared["inputs"][0]["displayUrl"].endswith("#ocr-slice-1of5")
    assert all(item["inputUrl"].startswith("data:image/jpeg;base64,") for item in prepared["inputs"])


@pytest.mark.asyncio
async def test_passes_non_tall_or_unprobeable_images_through_untouched() -> None:
    async def normal(_: str) -> tuple[int, str, bytes]:
        return 200, "image/png", _png(800, 1200)

    async def missing(_: str) -> tuple[int, str, bytes]:
        return 404, "text/plain", b"not found"

    url = "https://cdn.example/square.png"
    assert await prepare_image_ocr_inputs(url, fetcher=normal) == {
        "sliced": False,
        "inputs": [{"displayUrl": url, "inputUrl": url}],
    }
    assert await prepare_image_ocr_inputs(url, fetcher=missing) == {
        "sliced": False,
        "inputs": [{"displayUrl": url, "inputUrl": url}],
    }
