"""Small JSON parser adapters for the retained HTTP boundaries.

The internal Nest endpoints are fed by Express's ``body-parser`` JSON
middleware, whereas the console routes use the Web ``Request.json`` parser.
Those parsers deliberately do not have identical semantics, so keeping the
adapters here prevents a FastAPI convenience method from silently changing the
wire contract.
"""

from __future__ import annotations

import base64
import re
from dataclasses import dataclass
from typing import NoReturn


class JsonRequestParseError(ValueError):
    """A JSON syntax failure exposed by an HTTP compatibility boundary."""


class UnsupportedJsonCharset(ValueError):
    def __init__(self, charset: str) -> None:
        self.charset = charset
        super().__init__(f'unsupported charset "{charset.upper()}"')


_ICONV_UTF_ENCODINGS = {
    "utf8": "utf-8",
    "utf16": "utf-16",
    "utf16le": "utf-16le",
    "utf16be": "utf-16be",
    "utf32": "utf-32",
    "utf32le": "utf-32le",
    "utf32be": "utf-32be",
    "utf7": "utf-7",
    "utf7imap": "utf-7-imap",
}


def content_type_parts(value: str) -> tuple[str, str | None]:
    """Parse the `content-type` subset consumed by body-parser's getCharset."""

    length = len(value)
    index = _skip_ows(value, 0, length)
    type_start = index
    index = _skip_content_type_value(value, index, length)
    media_type = value[type_start : _trailing_ows(value, type_start, index)].lower()
    charset: str | None = None
    # Port content-type@2's deliberately permissive parameter scanner: an
    # invalid segment is skipped through its next semicolon, and duplicate
    # names retain their first value. body-parser consumes that package's
    # result before it selects iconv-lite's decoder.
    while index < length:
        index = _skip_ows(value, index + 1, length)
        key_start = index
        while index < length:
            character = value[index]
            if character == ";":
                break
            if character != "=":
                index += 1
                continue
            key = value[key_start : _trailing_ows(value, key_start, index)].lower()
            index = _skip_ows(value, index + 1, length)
            if index < length and value[index] == '"':
                index += 1
                decoded: list[str] = []
                while index < length:
                    character = value[index]
                    index += 1
                    if character == '"':
                        index = _skip_content_type_value(value, index, length)
                        if key == "charset" and charset is None:
                            charset = "".join(decoded).lower()
                        break
                    if character == "\\" and index < length:
                        decoded.append(value[index])
                        index += 1
                    else:
                        decoded.append(character)
                break
            value_start = index
            index = _skip_content_type_value(value, index, length)
            if key == "charset" and charset is None:
                charset = value[value_start : _trailing_ows(value, value_start, index)].lower()
            break
    return media_type, charset


def _skip_ows(value: str, index: int, length: int) -> int:
    while index < length and value[index] in {" ", "\t"}:
        index += 1
    return index


def _trailing_ows(value: str, start: int, end: int) -> int:
    while end > start and value[end - 1] in {" ", "\t"}:
        end -= 1
    return end


def _skip_content_type_value(value: str, index: int, length: int) -> int:
    while index < length and value[index] != ";":
        index += 1
    return index


def is_express_json_media_type(value: str) -> bool:
    """Whether body-parser's default ``json`` type would parse this body."""

    if not value:
        return False
    media_type = content_type_parts(value)[0]
    # type-is@2 passes the parsed prefix to media-typer.test: an empty
    # prefix throws, whereas a nonempty but invalid media type just misses.
    if not media_type:
        raise TypeError("argument string is required")
    valid = re.fullmatch(
        r" *[A-Za-z0-9][A-Za-z0-9!#$&^_-]{0,126}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126} *",
        media_type,
    )
    return valid is not None and media_type == "application/json"


def _iconv_auto_utf16_encoding(raw: bytes) -> str:
    """Port iconv-lite's BOM/ASCII heuristic for the UTF-16 charset."""

    ascii_le = 0
    ascii_be = 0
    for position in range(0, min(len(raw) - 1, 200), 2):
        first, second = raw[position], raw[position + 1]
        if position == 0:
            if (first, second) == (0xFF, 0xFE):
                return "utf-16le"
            if (first, second) == (0xFE, 0xFF):
                return "utf-16be"
        if first == 0 and second != 0:
            ascii_be += 1
        if first != 0 and second == 0:
            ascii_le += 1
    if ascii_be > ascii_le:
        return "utf-16be"
    return "utf-16le"


def _iconv_auto_utf32_encoding(raw: bytes) -> str:
    """Port iconv-lite's BOM/BMP/invalid-unit heuristic for UTF-32."""

    invalid_le = 0
    invalid_be = 0
    bmp_le = 0
    bmp_be = 0
    for position in range(0, min(len(raw) - 3, 400), 4):
        first, second, third, fourth = raw[position : position + 4]
        if position == 0:
            if (first, second, third, fourth) == (0xFF, 0xFE, 0, 0):
                return "utf-32le"
            if (first, second, third, fourth) == (0, 0, 0xFE, 0xFF):
                return "utf-32be"
        if first != 0 or second > 0x10:
            invalid_be += 1
        if fourth != 0 or third > 0x10:
            invalid_le += 1
        if first == 0 and second == 0 and (third != 0 or fourth != 0):
            bmp_be += 1
        if (first != 0 or second != 0) and third == 0 and fourth == 0:
            bmp_le += 1
    if bmp_be - invalid_be > bmp_le - invalid_le:
        return "utf-32be"
    return "utf-32le"


def _decode_fixed_width_unicode(raw: bytes, encoding: str, width: int) -> str:
    """Decode only complete iconv-lite units; its decoder drops a final tail."""

    complete = raw[: len(raw) - len(raw) % width]
    if width == 2:
        # iconv-lite's UTF-16 decoder is UCS-2-like: it retains a lone
        # surrogate code unit for JSON.stringify to escape later.
        return complete.decode(encoding, errors="surrogatepass")
    byteorder = "little" if encoding.endswith("le") else "big"
    characters: list[str] = []
    for position in range(0, len(complete), 4):
        code_point = int.from_bytes(complete[position : position + 4], byteorder)
        # iconv-lite's UTF-32 decoder preserves the surrogate range but
        # replaces scalar values outside Unicode's maximum.
        characters.append(chr(code_point) if code_point <= 0x10FFFF else "�")
    return "".join(characters)


def _decode_express_json(raw: bytes, charset: str | None) -> str:
    encoding = charset or "utf-8"
    # body-parser only accepts UTF charset labels.  iconv's decode path
    # replaces malformed byte sequences, allowing the JSON parser to produce
    # the same request-boundary error rather than Python's Unicode exception.
    if not encoding.startswith("utf-"):
        raise UnsupportedJsonCharset(encoding)
    canonical = re.sub(r":\d{4}$|[^0-9a-z]", "", encoding.lower())
    if canonical not in _ICONV_UTF_ENCODINGS:
        raise UnsupportedJsonCharset(encoding)
    if canonical == "utf16":
        decoded = _decode_fixed_width_unicode(raw, _iconv_auto_utf16_encoding(raw), 2)
    elif canonical == "utf32":
        decoded = _decode_fixed_width_unicode(raw, _iconv_auto_utf32_encoding(raw), 4)
    elif canonical in {"utf16le", "utf16be"}:
        decoded = _decode_fixed_width_unicode(raw, _ICONV_UTF_ENCODINGS[canonical], 2)
    elif canonical in {"utf32le", "utf32be"}:
        decoded = _decode_fixed_width_unicode(raw, _ICONV_UTF_ENCODINGS[canonical], 4)
    elif canonical == "utf7":
        decoded = _decode_utf7(raw)
    elif canonical == "utf7imap":
        decoded = _decode_utf7_imap(raw)
    else:
        decoded = raw.decode(_ICONV_UTF_ENCODINGS[canonical], errors="replace")
    # body-parser/iconv-lite removes exactly one decoded leading BOM. This
    # applies after UTF-8/UTF-16 decoding, rather than only to UTF-8 bytes.
    return decoded[1:] if decoded.startswith("\ufeff") else decoded


def _decode_utf7_imap(raw: bytes) -> str:
    """Decode iconv-lite's modified UTF-7 for the body-parser UTF aliases."""

    return _decode_utf7_variant(raw, shift=ord("&"), modified=True)


def _decode_utf7(raw: bytes) -> str:
    """Decode iconv-lite's standard UTF-7 decoder as one request body."""

    return _decode_utf7_variant(raw, shift=ord("+"), modified=False)


def _decode_utf7_variant(raw: bytes, *, shift: int, modified: bool) -> str:
    """Port iconv-lite's whole-buffer UTF-7 shifted-base64 decode path."""

    output: list[str] = []
    direct_start = 0
    index = 0
    in_base64 = False
    base64_start = 0
    while index < len(raw):
        character = raw[index]
        if not in_base64:
            if character == shift:
                output.append(raw[direct_start:index].decode("ascii", errors="replace"))
                in_base64 = True
                base64_start = index + 1
            index += 1
            continue
        if _utf7_base64_character(character, modified=modified):
            index += 1
            continue
        encoded = raw[base64_start:index]
        if not encoded and character == ord("-"):
            output.append(chr(shift))
        else:
            output.append(_decode_utf7_base64(encoded, modified=modified))
        in_base64 = False
        if character == ord("-"):
            index += 1
            direct_start = index
        else:
            direct_start = index
    if in_base64:
        output.append(_decode_utf7_base64(raw[base64_start:], modified=modified))
    else:
        output.append(raw[direct_start:].decode("ascii", errors="replace"))
    return "".join(output)


def _utf7_base64_character(character: int, *, modified: bool) -> bool:
    return (
        ord("A") <= character <= ord("Z")
        or ord("a") <= character <= ord("z")
        or ord("0") <= character <= ord("9")
        or character in {ord("+"), ord("/")}
        or (modified and character == ord(","))
    )


def _decode_utf7_base64(encoded: bytes, *, modified: bool) -> str:
    # Node Buffer.from(base64) keeps every complete quartet and discards only
    # an impossible one-character suffix; Python's decoder otherwise raises
    # for the whole input (for example, ``AAAAA``).
    usable = encoded[:-1] if len(encoded) % 4 == 1 else encoded
    padding = b"=" * (-len(usable) % 4)
    try:
        decoded = base64.b64decode((usable.replace(b",", b"/") if modified else usable) + padding)
    except ValueError:
        return ""
    complete = decoded[: len(decoded) - len(decoded) % 2]
    return complete.decode("utf-16-be", errors="surrogatepass")


def _utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def _utf16_window(value: str, start: int, end: int) -> str:
    encoded = value.encode("utf-16-le", "surrogatepass")
    return encoded[start * 2 : end * 2].decode("utf-16-le", "surrogatepass")


def _utf16_unit_at(value: str, position: int) -> str:
    """Return one JavaScript code unit, including a split surrogate pair."""

    return _utf16_window(value, position, position + 1)


def _node_context(text: str, position: int) -> str:
    """Format the JSON.parse excerpt used by contemporary Node errors."""

    # V8 includes raw source characters inside its quoted error excerpt (not
    # JSON-escaped quote characters). For input over 20 UTF-16 units it shows
    # the ten units before and after the parser position, with an ellipsis on
    # either truncated side. This is observable in Next's Request.json error
    # strings, including a token near the end of a long request.
    length = _utf16_length(text)
    if length > 20:
        start = max(position - 10, 0)
        end = min(position + 10, length)
        prefix = "..." if start else ""
        suffix = "..." if end < length else ""
        return f'{prefix}"{_utf16_window(text, start, end)}"{suffix}'
    return f'"{text}"'


@dataclass(slots=True)
class _ArrayFrame:
    value: list[object]
    state: str = "initial_or_end"


@dataclass(slots=True)
class _ObjectFrame:
    value: dict[str, object]
    state: str = "initial_key_or_end"
    key: str | None = None


class _V8JsonParser:
    """A compact JSON lexer/parser with Node 24's public failure messages.

    Python's JSON decoder deliberately reports a different grammar and counts
    Unicode code points.  The retained console boundary exposes V8's grammar
    and UTF-16 positions, so this parser only models JSON.parse's observable
    surface while still storing each number as an IEEE-754 double.
    """

    _WHITESPACE = " \t\r\n"
    _HEX = frozenset("0123456789abcdefABCDEF")

    def __init__(self, text: str) -> None:
        self.text = text
        self.index = 0

    def parse(self) -> object:
        self._skip_whitespace()
        if self._at_end():
            self._unexpected_end()
        # Contemporary V8 gives these complete top-level non-JSON constants a
        # special message rather than the usual unexpected-token envelope.
        if self.index == 0 and self.text in {"NaN", "Infinity", "undefined"}:
            raise JsonRequestParseError(f'"{self.text}" is not valid JSON')
        root: object = None
        root_complete = False
        stack: list[_ArrayFrame | _ObjectFrame] = []
        while True:
            if not stack:
                if root_complete:
                    self._skip_whitespace()
                    if not self._at_end():
                        self._raise_location("Unexpected non-whitespace character after JSON", include_in_json=False)
                    return root
                root, child = self._start_value()
                root_complete = True
                if child is not None:
                    stack.append(child)
                continue

            frame = stack[-1]
            self._skip_whitespace()
            if isinstance(frame, _ArrayFrame):
                if frame.state == "initial_or_end":
                    if not self._at_end() and self.text[self.index] == "]":
                        self.index += 1
                        stack.pop()
                        continue
                    frame.state = "value"
                if frame.state == "value":
                    value, child = self._start_value()
                    frame.value.append(value)
                    frame.state = "comma_or_end"
                    if child is not None:
                        stack.append(child)
                    continue
                if self._at_end() or self.text[self.index] not in ",]":
                    self._raise_location("Expected ',' or ']' after array element")
                if self.text[self.index] == "]":
                    self.index += 1
                    stack.pop()
                    continue
                self.index += 1
                frame.state = "value"
                continue

            if frame.state == "initial_key_or_end":
                if not self._at_end() and self.text[self.index] == "}":
                    self.index += 1
                    stack.pop()
                    continue
                if self._at_end() or self.text[self.index] != '"':
                    self._raise_location("Expected property name or '}'")
                frame.state = "key"
            if frame.state == "key":
                if self._at_end() or self.text[self.index] != '"':
                    self._raise_location("Expected double-quoted property name")
                frame.key = self._string()
                frame.state = "colon"
                continue
            if frame.state == "colon":
                if self._at_end() or self.text[self.index] != ":":
                    self._raise_location("Expected ':' after property name")
                self.index += 1
                frame.state = "value"
                continue
            if frame.state == "value":
                key = frame.key
                if key is None:  # pragma: no cover - state transitions set it.
                    raise RuntimeError("object value has no key")
                value, child = self._start_value()
                frame.value[key] = value
                frame.key = None
                frame.state = "comma_or_end"
                if child is not None:
                    stack.append(child)
                continue
            if self._at_end() or self.text[self.index] not in ",}":
                self._raise_location("Expected ',' or '}' after property value")
            if self.text[self.index] == "}":
                self.index += 1
                stack.pop()
                continue
            self.index += 1
            frame.state = "key"

    def _start_value(self) -> tuple[object, _ArrayFrame | _ObjectFrame | None]:
        if self._at_end():
            self._unexpected_end()
        character = self.text[self.index]
        if character == "{":
            self.index += 1
            value: dict[str, object] = {}
            return value, _ObjectFrame(value)
        if character == "[":
            self.index += 1
            array_value: list[object] = []
            return array_value, _ArrayFrame(array_value)
        if character == '"':
            return self._string(), None
        if character == "t":
            return self._literal("true", True), None
        if character == "f":
            return self._literal("false", False), None
        if character == "n":
            return self._literal("null", None), None
        if character == "-" or "0" <= character <= "9":
            return self._number(), None
        self._unexpected_token()

    def _string(self) -> str:
        self.index += 1
        output: list[str] = []
        escapes = {
            '"': '"',
            "\\": "\\",
            "/": "/",
            "b": "\b",
            "f": "\f",
            "n": "\n",
            "r": "\r",
            "t": "\t",
        }
        while not self._at_end():
            character = self.text[self.index]
            if character == '"':
                self.index += 1
                return "".join(output)
            if ord(character) < 0x20:
                self._raise_location("Bad control character in string literal")
            if character != "\\":
                output.append(character)
                self.index += 1
                continue

            self.index += 1
            if self._at_end():
                self._unexpected_end()
            escaped = self.text[self.index]
            if escaped == "u":
                self.index += 1
                digits_start = self.index
                for _ in range(4):
                    if self._at_end() or self.text[self.index] not in self._HEX:
                        self._raise_location("Bad Unicode escape")
                    self.index += 1
                output.append(chr(int(self.text[digits_start : self.index], 16)))
                continue
            if escaped not in escapes:
                # V8 tokenizes a non-Latin-1 escape as a UTF-16 token before
                # it reaches the legacy "Bad escaped character" diagnostic.
                # That distinction is observable for an astral code point:
                # the message contains its leading surrogate code unit.
                if ord(escaped) >= 0x100:
                    self._unexpected_token()
                self._raise_location("Bad escaped character")
            output.append(escapes[escaped])
            self.index += 1
        self._raise_location("Unterminated string")

    def _literal(self, spelling: str, value: object) -> object:
        for expected in spelling:
            if self._at_end():
                self._unexpected_end()
            if self.text[self.index] != expected:
                character = self.text[self.index]
                if character == "-" or "0" <= character <= "9":
                    self._raise_location("Unexpected number")
                if character == '"':
                    self._raise_location("Unexpected string")
                self._unexpected_token()
            self.index += 1
        return value

    def _number(self) -> float:
        start = self.index
        if self.text[self.index] == "-":
            self.index += 1
            if self._at_end() or not ("0" <= self.text[self.index] <= "9"):
                self._raise_location("No number after minus sign")
        if self.text[self.index] == "0":
            self.index += 1
            if not self._at_end() and "0" <= self.text[self.index] <= "9":
                self._raise_location("Unexpected number")
        else:
            while not self._at_end() and "0" <= self.text[self.index] <= "9":
                self.index += 1
        if not self._at_end() and self.text[self.index] == ".":
            self.index += 1
            if self._at_end() or not ("0" <= self.text[self.index] <= "9"):
                self._raise_location("Unterminated fractional number")
            while not self._at_end() and "0" <= self.text[self.index] <= "9":
                self.index += 1
        if not self._at_end() and self.text[self.index] in "eE":
            self.index += 1
            if not self._at_end() and self.text[self.index] in "+-":
                self.index += 1
            if self._at_end() or not ("0" <= self.text[self.index] <= "9"):
                self._raise_location("Exponent part is missing a number")
            while not self._at_end() and "0" <= self.text[self.index] <= "9":
                self.index += 1
        return float(self.text[start : self.index])

    def _skip_whitespace(self) -> None:
        while not self._at_end() and self.text[self.index] in self._WHITESPACE:
            self.index += 1

    def _at_end(self) -> bool:
        return self.index >= len(self.text)

    def _position(self) -> int:
        return _utf16_length(self.text[: self.index])

    def _line_column(self) -> tuple[int, int]:
        line = 1
        line_start = 0
        cursor = 0
        while cursor < self.index:
            character = self.text[cursor]
            if character == "\r":
                line += 1
                cursor += 1
                if cursor < self.index and self.text[cursor] == "\n":
                    cursor += 1
                line_start = cursor
                continue
            if character == "\n":
                line += 1
                line_start = cursor + 1
            cursor += 1
        return line, _utf16_length(self.text[line_start : self.index]) + 1

    def _raise_location(self, prefix: str, *, include_in_json: bool = True) -> NoReturn:
        position = self._position()
        line, column = self._line_column()
        qualifier = "in JSON " if include_in_json else ""
        raise JsonRequestParseError(f"{prefix} {qualifier}at position {position} (line {line} column {column})")

    def _unexpected_end(self) -> NoReturn:
        raise JsonRequestParseError("Unexpected end of JSON input")

    def _unexpected_token(self) -> NoReturn:
        position = self._position()
        token = _utf16_unit_at(self.text, position)
        message = f"Unexpected token '{token}', {_node_context(self.text, position)} is not valid JSON"
        raise JsonRequestParseError(message)


def _strict_json_error(text: str, first_position: int) -> str:
    # body-parser strict mode replaces the non-object/array input with '#'
    # before JSON.parse, then restores the original token in Node's message.
    unit_position = _utf16_length(text[:first_position])
    first = _utf16_unit_at(text, unit_position)
    return f"Unexpected token '{first}', {_node_context(text, unit_position)} is not valid JSON"


def parse_internal_json_body(raw: bytes, charset: str | None) -> object:
    """Parse a strict JSON body for the internal API compatibility boundary."""

    text = _decode_express_json(raw, charset)
    if not text:
        return {}
    candidate = text.lstrip(" \t\r\n")
    if not candidate:
        # body-parser special-cases only a genuinely empty byte body.  Its
        # strict parser feeds whitespace through JSON.parse, which exposes
        # V8's end-of-input error before Nest's API-key guard/DTO pipe.
        raise JsonRequestParseError("Unexpected end of JSON input")
    first = candidate[0]
    if first not in "[{":
        raise JsonRequestParseError(_strict_json_error(text, len(text) - len(candidate)))
    return _V8JsonParser(text).parse()


def parse_express_json_body(raw: bytes, charset: str | None) -> object:
    """Keep the legacy-named middleware entry point for route wiring."""

    return parse_internal_json_body(raw, charset)


def parse_console_json_body(raw: bytes) -> object:
    """Parse a Web ``Request.json()`` body with JavaScript's strict grammar."""

    # Fetch's body decoding is UTF-8 replacement decoding.  Unlike
    # body-parser strict mode, Request.json permits JSON scalar values.
    text = raw.decode("utf-8", errors="replace")
    # Node's Web Body ``json()`` path consumes two leading UTF-8 BOMs: one
    # during body decoding and one at the JSON boundary. A third remains
    # visible to JSON.parse and must still fail as a token.
    if text.startswith("\ufeff"):
        text = text[1:]
    if text.startswith("\ufeff"):
        text = text[1:]
    return _V8JsonParser(text).parse()
