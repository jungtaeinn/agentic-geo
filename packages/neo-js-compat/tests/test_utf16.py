from neo_js_compat.utf16 import js_code_unit_length, js_fnv1a32, js_utf8_replacement_text, js_utf16_slice


def test_utf16_length_counts_an_astral_character_as_two_units() -> None:
    assert js_code_unit_length("A😀") == 3
    assert js_fnv1a32("A😀") == js_fnv1a32("A\ud83d\ude00")


def test_utf16_slice_uses_javascript_code_unit_offsets() -> None:
    deseret = "\U00010400"
    assert js_utf16_slice(deseret * 80, 0, 80) == deseret * 40


def test_utf8_storage_replaces_only_unmatched_utf16_surrogates() -> None:
    assert js_utf8_replacement_text("A\ud801x") == "A�x"
    assert js_utf8_replacement_text("A\ud801\udc00x") == "A\U00010400x"


def test_fnv1a_uses_the_signed_state_magnitude_from_the_embedding_snapshot() -> None:
    assert js_fnv1a32("") == 2166136261
    assert js_fnv1a32("A") == 1005848884
    assert js_fnv1a32("A😀") == 540312359
    assert js_fnv1a32("한글") == 1218614591


def test_embedding_snapshot_key_matches_the_typescript_collision_guard() -> None:
    from neo_js_compat.utf16 import js_embedding_snapshot_key

    assert js_embedding_snapshot_key("") == "2166136261:0"
    assert js_embedding_snapshot_key("A😀") == "540312359:3"
    assert js_embedding_snapshot_key("\ud800") == "75617567:1"


def test_unsigned_fnv1a_variant_has_a_distinct_and_explicit_name() -> None:
    from neo_js_compat.utf16 import js_fnv1a32_unsigned

    assert js_fnv1a32_unsigned("A😀") == 3754654937
