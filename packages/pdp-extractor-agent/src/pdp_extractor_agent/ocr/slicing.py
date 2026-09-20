"""Tall-image preparation compatible with the extractor vision pipeline."""

from __future__ import annotations

import base64
import inspect
import io
import re
import struct
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
from PIL import Image

_SLICE_FRAGMENT = "#ocr-slice-"
_SLICE_HEIGHT = 1400
_SLICE_OVERLAP = 0.15

ImageFetcher = Callable[[str], Awaitable[tuple[int, str, bytes]] | tuple[int, str, bytes]]


def slice_display_url(image_url: str, slice_index: int, total_slices: int) -> str:
    return f"{image_url}#ocr-slice-{slice_index}of{total_slices}"


def strip_slice_fragment(display_url: str) -> str:
    return re.sub(r"#ocr-slice-\d+of\d+$", "", display_url)


def parse_slice_fragment(display_url: str) -> dict[str, Any]:
    matched = re.search(r"#ocr-slice-(\d+)of(\d+)$", display_url)
    if not matched:
        return {"baseUrl": display_url}
    return {
        "baseUrl": strip_slice_fragment(display_url),
        "sliceIndex": int(matched.group(1)),
        "sliceCount": int(matched.group(2)),
    }


def read_image_dimensions(buffer: bytes) -> dict[str, int] | None:
    if len(buffer) >= 24 and buffer.startswith(b"\x89PNG\r\n\x1a\n"):
        return {"width": struct.unpack(">I", buffer[16:20])[0], "height": struct.unpack(">I", buffer[20:24])[0]}
    if len(buffer) >= 10 and buffer[:6] in {b"GIF87a", b"GIF89a"}:
        return {"width": struct.unpack("<H", buffer[6:8])[0], "height": struct.unpack("<H", buffer[8:10])[0]}
    if len(buffer) >= 4 and buffer.startswith(b"\xff\xd8"):
        return _jpeg_dimensions(buffer)
    return None


async def prepare_image_ocr_inputs(image_url: str, *, fetcher: ImageFetcher | None = None) -> dict[str, Any]:
    fallback = {"sliced": False, "inputs": [{"displayUrl": image_url, "inputUrl": image_url}]}
    try:
        status, _, body = await _fetch(image_url, fetcher)
        dimensions = read_image_dimensions(body) if status == 200 else None
        if (
            dimensions is None
            or dimensions["height"] <= 2048
            or dimensions["height"] / max(dimensions["width"], 1) <= 3
        ):
            return fallback
        image = Image.open(io.BytesIO(body)).convert("RGB")
        height = image.height
        tops = list(range(0, height, int(_SLICE_HEIGHT * (1 - _SLICE_OVERLAP))))
        total = len(tops)
        inputs: list[dict[str, str]] = []
        for number, top in enumerate(tops, start=1):
            crop = image.crop((0, top, image.width, min(top + _SLICE_HEIGHT, image.height)))
            stream = io.BytesIO()
            crop.save(stream, format="JPEG", quality=90)
            data_url = "data:image/jpeg;base64," + base64.b64encode(stream.getvalue()).decode("ascii")
            inputs.append({"displayUrl": slice_display_url(image_url, number, total), "inputUrl": data_url})
        return {"sliced": True, "inputs": inputs}
    except Exception:
        return fallback


async def _fetch(image_url: str, fetcher: ImageFetcher | None) -> tuple[int, str, bytes]:
    if fetcher is not None:
        result = fetcher(image_url)
        if inspect.isawaitable(result):
            return await result
        return result
    async with httpx.AsyncClient(follow_redirects=True, timeout=60.0) as client:
        response = await client.get(image_url)
        return response.status_code, response.headers.get("content-type", ""), response.content


def _jpeg_dimensions(buffer: bytes) -> dict[str, int] | None:
    index = 2
    while index + 9 < len(buffer):
        if buffer[index] != 0xFF:
            index += 1
            continue
        marker = buffer[index + 1]
        index += 2
        while marker == 0xFF and index < len(buffer):
            marker = buffer[index]
            index += 1
        if marker in {0xD8, 0xD9}:
            continue
        if index + 2 > len(buffer):
            return None
        length = struct.unpack(">H", buffer[index : index + 2])[0]
        if length < 2 or index + length > len(buffer):
            return None
        if marker in set(range(0xC0, 0xC4)) | set(range(0xC5, 0xC8)) | set(range(0xC9, 0xCC)) | set(range(0xCD, 0xD0)):
            return {
                "height": struct.unpack(">H", buffer[index + 3 : index + 5])[0],
                "width": struct.unpack(">H", buffer[index + 5 : index + 7])[0],
            }
        index += length
    return None
