"""Evidence-led conservative content planning.

Optional model planners can enrich this plan, but the default never invents a
public claim: every selected field carries evidence IDs from the ledger.
"""

from __future__ import annotations

import inspect
import math
import re
from base64 import b64decode
from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Any, Protocol, cast, runtime_checkable
from zlib import decompress

from neo_js_compat import js_code_unit_length, js_fnv1a32_unsigned, js_json_dumps, js_utf16_slice

from ._json import as_dict, as_list, clean_text
from .contracts.certification import contains_serialized_metadata
from .contracts.customer_situation import states_a_customer_situation
from .contracts.metric_statement import read_reported_study_scope, states_study_method
from .contracts.product_identity import (
    GENERIC_ENTITY_NOUNS,
    clause_without_containment_owner,
    product_entity_reference,
    product_title_without_sku_qualifier,
)
from .contracts.product_type import product_type_from_name
from .contracts.sentence_form import (
    KOREAN_CONTAINMENT_FRAME_FORMS,
    english_subjectless_predicate,
    is_complete_sentence,
    is_korean_complete_sentence,
    korean_content_stem,
    korean_word_is_role_marking_only,
    names_a_thing,
    source_phrase_matches,
    split_into_clauses,
    states_only_what_the_source_states,
    strip_korean_particle,
)
from .contracts.suitability import audience_designations, is_suitability_statement
from .contracts.usage import (
    extract_explicit_numbered_usage_steps,
    has_explicit_numbered_usage_marker,
    is_concrete_usage_action,
    is_raw_page_text_block,
)
from .faq_relationships import (
    CARD_CLAIM_CONTENT_FIELDS,
    build_faq_relationship_cards,
    states_a_customer_relation,
)
from .final_proofreader import select_rendered_sentence_evidence, sentence_evidence_has_direct_claim_support
from .normalization import (
    infer_pdp_evidence_roles,
    infer_pdp_evidence_roles_for_ledger,
    is_compressed_multi_claim_metric_block,
)
from .providers import create_provider
from .review_cep import derive_cep_situations_for_planning
from .review_sentiment import is_positive_aggregate_rating, is_positive_review_body, is_positive_review_keyword
from .token_usage import merge_token_usage

_CONTENT_PLANNING_SYSTEM_PROMPT = decompress(
    b64decode(
        "hVxNjxzHkb3Pr8jbkFB1D3aPMzAXNDmWaMvimKRWEAzDzK6K7kpNVWYpM6ubrYMgw8JCsBcLrSGtZYBc6LDYD8AHAZIBHfbX+CgO"
        "/8MiPjIrq2fovUic6a6s/Ih48eJF5LzvRqU9KG0VbE0DtobFyo22URf3L1TtbAQblbaNCnULvVZ6GDpT65XpTNyrodPWgl8ePYI4"
        "equc7fYqtqA8fDhCiNCoEL2po/rp44fvKLf6AOqojKXvRO03EFXnat3B8uh8C36v1rqOo+7UMK46Uy9qN+xV3ekxgOrHEFVtIihn"
        "QTmveudBbXVnmjz5B01Yqnv8HZlK6HXXQYjKQwdbbaMKECtlnccP9jRYdCq2HkA9uB/UAF5eeaYsbMErHaOuWxoNbDQeVAfNBvxS"
        "vUOfG7ulbVKDd81YR1pFpfTYGJxUpYzdeMAf4mIFFtYmqlqPQXeqM/ayUj3gLlWqBh/N2tQ6GmcrVbt+0N4E/LfzajXujd2oYOJI"
        "X1ge/RjWuAeN1+to7KbCeYdg1nsFtJu4W43S0fVqtc+bpLzrgA7VQ0cjhdYMKtRugKV60OAa414Z+sfaQKCVy9rO8rKU1T0EMp1n"
        "aBQmdnsVxmFwHt9ajyG6HvxZsXp5BNflgsE3nynZkBNYr9E48qBujLXr4UyNQW/yy/KwStf8PO9d/rwHHUYPuLYwdvFMedga2KXP"
        "Y/RmNeL84NkAnhZyhhPqweclufUa/MlWe4PmgocZzlRwI37DhLRGPIsIz6LatS7IppKNhmi6Tq1AGbsGj3NZe9ezMQJ6FA4TA3Tr"
        "pbp7YMDqwX18hXUR7bA3IRhn0T7RA2KrI5/m2nnco9HSCeJqHfrQkzaZJk/H8NHhI8dBDd702u/VB261VO+1YFWAXtto6keuw2X7"
        "uUEYfARwyhW93kScCP3KbwH3euyiWdCb8sJ4YskiSsuXAz0JrfbQLEIcm/3shcndem1HwgEEpvmUaCNxOYE3owcP3R5RCbRXFv8D"
        "6KoutghL5bM/wrNtFhHq1rrObfaLBtbGkhWqXvtLsjraXRo6RB0hqB3tORlGg9vej53GRU7j4D71ugHl1vhB63a4UzvnL0NFBymT"
        "NDHQMEv1CHRnPqIN1WizefPoxbh32lg+uuk1FXns4GGNiBOVw63yMIBmS2zZehFdtepMiHLGZHb4QTYx3QWXloef1s6G6LWx8eCV"
        "StuwAx/UXz/5gtFtAB/3uFD8YuHXfBj6MmEFLoB2Sxl09WBWHdAoHehG7Uxs+ZHi1cExwOLqLZ2a8qCbwFtUUwjAHcBt9BBcNzJI"
        "RlwkRipjR0FyKGBIrI7iBUNDDzYuFYebEBFbaD04mxanTT68gkNgi+RnaJeTOzO+po09U7u04cW6TFB6xU5EY9DnhenpDiMQrqxx"
        "ZC45mnjQwdE2KhOXR49h0B4HECTSIWC4cDZU8qvFSteXGHP3NrYQTGCb+XDEpbb7Ab0iQFiqC4quqoFQezPIGD+5+wtFURt/PJGj"
        "r9RbbvfE8UA1DBgAPYaEXu9p13HHKNZemxVueZ6JgKSEJcR/C7w501GtUsBKYTRt7FK9CRa87lStI2yc36tL63aEdOwVGK7JxgJo"
        "X7c4C1cb9n0iOASoRXQOy6ML/nFZ7EICzISUvAkLtMO9evP8oZLQGMZePm9oI1ageh3BG2IUxEsaiNp00KBlWfUerC70Bsp3LdXT"
        "G2bwNJsfB0kM3wQR5tli0D4iCQC/4Ikpq73X0WzhNC/O2Mj/Ms6exP0A6o3EtKbQiWfpbA3entw7v1BvlK48x7YiVKs3irNC8w0t"
        "NIv03oMw/kYySfEbDBp0MinIQLPQPpq6Iy/S8oIiPvNrt+S5FsaIxy+x/BL2O+eboDqNMPfEg2boyrvkfIPrDNmLECK1r9XGI7uF"
        "BmESl45bcb44X9xdPKkS2wsCoIgLwTxTawNdI2duIJyqDuIByuBQDUSM2LYIhkSl6aFKRa8tb6S4pdBanNFA5I1oNkEEOdRNMTS6"
        "TCBzbFuqx7OtbhDYK2bQoQV/Ek3soMIja4zdyNvt2K8Q2pO5DdoH2pbolNVxxO0evJtIcN1qi+6GhGVkt7Ml+yWuYjfIx3Sjo16q"
        "u1bBGtlsvV/k4LPqXH1JTmNs3Y0NMIsYOkhQHXj5GUuThQnA0H6Rm/YKj9JPEY4phfNq7Vy0LsJSnT9DwEYr7oDSEb2GuFcRQmQM"
        "C5GmQoNkG06TJZqHQWY1xrTafuj2arRmCx4JPA+IL+LVDLq+xJgSzEdQIZAg/9c77RskdDVYjDiV8jrmMxerrt1oJbakbStDFp7z"
        "pRmUtilsJUiVySINkTPAUZOReui1Ifunp4KqO6Kr2l6GdLaDbpDOydMyOgbpjLcbBmATyZb5KQ/sZoN3bq1WnIsQDwG0JALcLSR7"
        "4xd517sICpqRk5wS0wmX2QKLcz+e5QtL9Z7H9I5YXvYzLTyXUVGeT7GMfsAYKzNE39GG4uB7LciUxbgy6dunMI4gqTAJw4W4Acrc"
        "dZERtdgy4aXoLib0ytgQkfMIZwr7foiuJ6rAc8Eg6jWaY2yJcadVE32SIREFG2Mx5tCv02ho9bElS0rkQk9DJrsuQZxmOiWuHCzQ"
        "radks9yQxgFnI0juioOsW+11jSHvo/QwEA+V+S+PGJX1jE4G4dFzB5+zqMQqggyLfjujwYN3NYRQsaMzIWdefVc1MIDFvBWJcoOJ"
        "NKi11xt0IFXrIY6zdAwsHcxBkiHALGnYbAXEsCnqC2y63kSimegOO48/2Gn89dh187EnSnOf2d7a+Xp+Qjh8WleIfuREKLoNYFLD"
        "FqGThdXoQM5+MFpJh3Hmedt4JSEFfIuRmYBzfgAbrzG20dcmkWCmDXCkIx76jkBGiKAe3nukVmPXQQyVqlsgaKfEJ0EwWvzKdfQx"
        "RuZOr6Djw0OKVLeQYpEKKBrZGgQDtJqxpUfApJpCQQ68DPmcEc5iF6f/i47pZIBTdQlIXxE3JIJFeX10lFRE06MBO1+6Ak03ORdn"
        "ruTSJlL6cYLB9mRww8ibddJDbF3DytmzqBzJP0TuTUD/GE1or5MnnmxgwylTZjwmpP92sTXRu8l8jh7YCBtKB14T3HRg+oELBHo3"
        "KzyTDkbJPE+gbh0FKjJ4llGiVnR+hCg4AsoZKJqRkdbaovlTNooTapbqHscVCmYpEym5NWl5q71qjIcaU6pE9lL6Op0q4Anxi5wv"
        "lBqccsLccKb01pkGLTEgT/RAJrojpNzM9IGg92FijTtEXkQE4yw0Cano+zflBJlLYgy5d35BNlWkqbJr2XwRUYydkOiAPkpanv1M"
        "Vh0kWE9OV5Uum5dN4dDWntxbwlN0OWKlAyXmb0I+7Gmwm6CF8QCd4HrGi/JONUOQa+abpBw24mspeAO1CWwB5BVL9W6A7KgFL5a3"
        "9Csk0br5QNcE2wJiBFeNI0OeZCjkM9r0Sb28n3JoVElYY8WETewAPb0nVqLWndst1c9ZPKQhAvk3QYCdaNWbSDer0ucrJHLGNZWa"
        "/J4k3BZ/h0tImsNa9wY3snVj16gVsBBhE1HN9CUHeQGYhB5yAo4oDmEzZs+CU4M2+F16Fk+OQG159CYlOIxzmPAwMzGWviOZDquF"
        "6pw4FH2ehB5iwZhhHgdlcQrplBKZOmVBzAhbuWVELb6tFnfwt4YMTPWgbt07vzidxOqKWGFVKCP0SBrNxKyh3SJ/jwYx+zAuMn2Y"
        "AvI0BhEVg/+nCZA3Ew+9dU0LkofywTxQK+gMbImO3dJjbJ2nlHQLFkI4FYKSUtjqUGMOfAjJIhu2xXJqagCHGU5nLhF5SkS7Nf37"
        "tEx/JSnotN2MegO3l+oij9+7hs2a/EVvQcegau3ROPyIKfG9AjmE9tMcs9Mxf+Xay8wFaeM8sNw8GUNmwiJLtt6Nm3bRGQtnnGQj"
        "SMqGogeigIaCTHQqAAgITvlwoqYJSzhIT9Io0Xlfp6+VDKXWTYLZa2UkdetnzoO2lTq3G0x/iWj8VA/aAuqHeAC3MflqKW/Ultfe"
        "sYaKrrk2z/AEk2uuve6hQt/VaUtoWkFeuCiRPksNyyPBoWkjiaqXYQWt9OkNutBTWuSN2tBS/djFdibbMRFdu65D2bnQftD6DnWf"
        "xZ2ZQy3uHKo2izvZyk+uqTOLOzfYZwqqnCLLckjzZBZVRzXoDZysvLbNCROQUj27SLJVEF1UVDMJLQsR3LLQVYrakrIV8bOvlHdI"
        "KCChpESU12X/HzgxsIFydp4Yg7g+ULDckFEIoZQy+5wGCC5xTmfZmEU13xpWJo1dZKvihw3XueyCXl4725hsGSvA2Uv9zjbiyBKx"
        "G/UQK1RTchYiTStrxer8GaJREAuo1Gix0AhNef68zNcJeejpqDd3HXRTMhUOJZdMAUau7bKKvydA+Buc6SyL3cF1Ior3+H3CiUWy"
        "kLRhodTHdYNb8hpVTMqqQlWcX6qHvYksYkvJMKRCCpexMphTAA3Lo584f5Nei9vLAZg9vyqyZy5ckLHLfgxapOm5Mk9uwCWaQmQj"
        "S18bj5LjAKzVyMoTyY16jBjxKOGjwRGZUM5TYSTBmybB6KeOf0kv+tXVi6/UL+UFv1JXv/3Nqz98pl79y1dXL767+q9PXv7uC/VL"
        "JIrpo6sXn6qrf/rnH755/urL/3n5+89e/v4/jkkPbiHhqTp+gnF/GnS24Lwj6P8ydBI0mPXR1xJFZ9ZpOebIyrODT7+SqizF0uyr"
        "resQdSghT30KdP6ewsutyTxCJSkHS6/k/JXgFyai6ErhdlZ/LZZrouc6D21x3uHjq0+/fvXbF+rq6y9ffvsdbc1xgI6HLtOjY+Ef"
        "NO8yjEYdLmfhB9MGfjwHUUytUKtdqrexppD5rwRXJK4p/h4Q7Qz0Eq2rRPYrxQCf4bFi0a5KiEjALHsxEyWRNbgxSqERgVlvYCFw"
        "jHJS2ppsVerlt9+//PP3V3/8/OrT5y9/98VxVXzIv1Wv/vTl1YvvX335tbr67Ct19e+fyfdIe0IRTG/gmEL3cT5wrlq2bheOl0dc"
        "D4pQJVDA5LKal9inBOdGpnBQxEvFgJyXIXrTZKjlBYKCD0cq70SX3IyKB+IXbozDWCDvdCoHESmT/eQ5OmT0xBjqruHVGYeprJOX"
        "orDgMSUVZV09me6thAg/fPOnqxefqKvfP3/1x6+Oq8mfTVEipmePb8/lIePnyRCWuuoWwhkrKkVc5LCWlKozUZp5wTuHG7d2o58q"
        "O9fpRJnqg+/DUv0jxYG9jfpZgkyUDmrvcJNn8YFt9AYwJpCY1oQlFc4CQyro1Z32Ju6XR1gEzQXgFVo+2UAYoMbGnCxvZr0/q9dZ"
        "0qa5iF6+mOqUubQqur2I1TtyahbpFQRcEVcRR8sVl0aaPailIb2/yo6XUTFcGqtWBH8eqYVjfoCqaKGEYzqCtWe4Jje7nf3/uhzI"
        "0W5eL/oJclDMSF+j6+qaKhxBSMqZNBsEIn+7FgQU887w8sP1QpB8wLpL+eC0ztyJEFo9AGu8U819qd6R4GtsBO/dhril2nlsJPFs"
        "TfMUydh1wnlBHEouUabk3pMt+JWOpmeawEtmUgzzxjYPvQmQEps85Sm/T8svut5WMC+TT7t7rVR+9OPRdA0V85FzYOFJdMVJGaV2"
        "J9uwYlmIndgoYMSZkiKwdr4Y43X1+QtuS0lZ4htsjUgATpLBlF1ws1IyC0xznnTv/ILgv0CIMcBiDdBhcus6UkC6EXnGDqPkovag"
        "+2y6VNkTzVqr1sXFRK9x2DU+EnbSO+Nh7SFgGYXekA+lrPvRl7my4rpKtYQ0KBz21NpRumi7DyZzNQ68y5ToLDKSTHhAR2y5lHMI"
        "XUX5aOTSnmrA1NHUOWgwVUJ0G5xB/0o06RAqrl58p66+fv7qD59V9O9Xv/nzy//832oGBBXzPRMUbehSPaacVneV2ph1ZG7QmTWl"
        "RRtIUlWgjk/sjKTgQLnL6D2S8+vGgrbZYi3IpZCMipGxph97roJWU42Fd58K1A1p2Y5qqQ51h4/Au2IfTZBmut1BijjlSdkkxgDr"
        "sUvMUKwdV4tePjWPsmpfFzm0IaqZ2s+mpo8WukHp1KPpvLQtJu3zLDXQckedCHrZ+7euG7GyJJ0qOefejNprGwFxnB07jCam9tvk"
        "ozoleifJARd3Xp/YLe6o3pX9sKxiUcJHldzFnVIGlsSxcF5q+EPxQMoLc0AhIdA2ZmuaUXeLJJEhecJmUtxkKqbkX4SpIiDScd7s"
        "W2uS/zXm7xVymOdXL75XV9/89w/ffIK0kRIWZpBXv/tLkbEcP8gzyCIdYsJW+/3x7VT2Zhqb+irxsEkIRgrMqlo1ZeXkGFQQMSGX"
        "jpbqZ0iBcnZdbNKNuTWDAfIWbuVCvYvSECT90qK0han8jx1U03kv1d1wycpuNhwJI1zY0JxnCKcYA+D8u859OBqMPK3XBCHSeNFU"
        "uYEj8xs6wUVogZ2SwqPV3UL6iuULautqvRo77fdnKrrB1DmlEx2Hk1mqTFNGxSEN7AaJsPDHpfo51pSpuH2Q9SLczYJhUQpORX7p"
        "0bS4bmyhqw66HkIUE5NtTAXMScy7NrHOrCNLFmkiObIRmiToptZLkiWlLc3YeSBPs0a58RRzPGkeNJvRw6FRTVWEVFWjKHuWnutz"
        "g2XiirqZKDuRw+v1dzEoVjN08v2A2FupHbVQSGdrdjYeHWN2mQuPDTZyoOlg10AKUjl3EWkq4Y7zufiR0160CYRBsg/i1Gep+kZJ"
        "L4HPxM6vOU079tou5OIBPZUpJTwzARtj3pHGrUvR/iFbblnPrp1v1K1jWvdhVJrLiP9wfLsQGvPRchxJe5AqPlnhpWDDTPpUHded"
        "4fI8J1W8Qpxe/mCiiceGKtu4K7qjFsoQ8Idj5srFhxW3Nu9MSK023Bl3zNVPahdMTyfkO8Yc4OL+xSJ/h3NEYfQWsJ1CeyxVpaYx"
        "amgYgHofEaAQLIJTSTOLlMFQhsZu98O3f/nhm+cvP39epdZ0obsrs+qM23g9tFhnk7iWToxKwnra4CwMjVGSdmLKnMlzKizWRxUi"
        "4N5O8vcR+98fUqmWuO9ejG/wxlFqpx5E6NXfEUIddu8UMZXaWUmz5HbgM2Xwub+fnmPmv7ijWPohUdVDpp5F9DwMmuFvxeW0J9xY"
        "IVk8qqGUylEnyTRcEuy5985xXfkJGiyqo2RqibpU2c4a5iQV3VogIMLsq1Jy0WF+38SDhR3Zm0/JeWZay6On/KvHqboXnlLHZBD+"
        "c8JdKEINr/VXVRzEcumSU52KC9DTRQixLW3VU+fNxtinp+qp7NrT7OmkdEr+yvaE5ROe39MEj1PxHL9G0XKpHuI2ZfLCiQBHY7Qq"
        "hNkiVrBVjYawihpyZenTCLN7MlmKn7pTqadUzzuME4PkclANw9OMqbMXmljEkendVGjh/m4y9yB+h13I+hIqtWsN3vWZZkV1OIyO"
        "Ok69xcVwGDRS0NPFdvMJcOjT0/5SycyVPZhTwTcYDuVrUxvS5Id94gchemfxmsqECBfayOWNaT5ZK0sdhdh9aVJLIWb5QhNy1KNe"
        "AIZazFfzy8XJJiF08qXp+pW4B3cA8YWgmRyoc6smszXcRcLLFEvTNChQOI9KT4/TRoAJS3Xfu2G239ZNM5x0EmH1RerHvyJ+JR2i"
        "1xvhl0cUsPTr5Zud89Q6hoaFPSqRvKGiuGmyZeZuDZOVlsnX0MaKLqEZbVSdc5fjcDpJUozASGqs26nG0daG6Aacit9nPlAlsyhb"
        "NvdERa7LV3S4OlweXM2RrkDuecnXRnCCiulsqgRCTMXww9bIicJ13PGfo+Hy6C5FBHK3g4rOBHjXeh3IkFK7w18/+YL7hKRkqkLn"
        "Ntou1QPLZo+3KzDWMKOYjCS7V1ZMDuq6J66udcjvzQ9c6xOiIhoE6hsRmpY7e9J1FQbMosEu1zfmCsqNd7xOittV0aUbX1IXX6q3"
        "QW9nd2OgH+L+9en69XuFqT2hE9Cgq57ZcyhbnN8wKZuPuSlIS42wKsP+TVc0OfSJeD/rhpRuotwUsHPSu1y7havr0U+yyQnKRi1L"
        "YxQNK6wDwMKtF43eY2zmChWKK9TGG73eYschaizcuiE9RTTK5vAezOyiS9Jg8sm8ToOZWmRCrp9hX9aDtYhFthwYzZ71Enquo6qU"
        "XOfI9zpIKXPTK9D8sZKRAQsGjuZdutyb2A39Fmu6aqe95RwGuA3jF++eP3r/12+9f/HwyVvnjx88/vXDd95+nzlg+i4mF0ZvrAuo"
        "iU2ykZNLNINJtxrkrVIsXB5hORKhMDrcMCraaL4tjDeE6fKHXI+keJqlID4DFIwXsvYw+rXGKsR0z5PjW4gHd0QGHdtwWlreyYEz"
        "V8lb0YGuB6sDVGftNMeQojJUlPqKct5UX5HKys0NQYmH45O5bVJqLnkfRAljkTSV4ZDsYM+vdXbfuzEU8hzZG93/Sx2C3ExNqTIJ"
        "ZiBUBgkp9Wk4MozRFveO+O7WPX4Pl8nmzcxFWwiV7fSEgxuH2RWaG00Ey+0WkgSY7q/VU29EWhTffMF4mWuKyB5BlUlpkaYk0Z7A"
        "j/RcuWceIgxnUyEPf5y8dn7fkLpOocnLSc2l2cJzAwPFcWJnRLJGG0/o4dwMGYbO8FLLOZJP8P08UpNpLkx9qP9ytGkKqHrlnmyK"
        "sw3twF219jytPX2nSk5ZKd2zjJvgc+o5oYJPIYBQzhGNZF88TGIwZdd/btPIgQvnKk4jWaportpC3aBSNxOQ6TA0rTNXtXU6/FJu"
        "lw3CC4Kyw2UdMVTX7rNX6TIV9tkY9IhJ0hG85z6ydPFLOvaSZYjpYkrNYQTTjzGgvPhu0c1fJWflJkoT0P1I9e8wCs49OFdGc6dN"
        "b57lbkLiYQNA3S462EIn00M5MrhuO3NgrOQsqJ24uDbIuT/bBP0BhdnLBU6TVwiJBbwqgajSjOw13AWYvSFNLoiqWjL0eZ9aZup8"
        "7Nf+bgL5iNiLCNDFNalU1M6Vilk4Ij4mRfP5/VhbShbilpI35i6Ij1/96/Mfvv/m5edfXf3bd9TYgII0b1PWbeTAjj/OXTYnH7/8"
        "PDfc4BuEzGfVkrKBkWAe+C9YJBX3BDqzwQazH611F2hP6E9xMLXCsH5Crs27InfLKTQ/ElZ2z9n1dIWsvIazTvoU95jtMYHlCLpO"
        "1cZHd99Um9E0Wh7HtdX74v5Dl7pU7VTKkba2cEP18t3UZFlTRXYFAdkL/oRX/9KLUhJd/JEQnB7d4KtbvIFyyo2dfFc+KLZyt56t"
        "KqPHWtdUseImgGqSoaXVdJJQVAPYKSstgju9lzGx2QyHoLrlrMcuWaz028gh5CD8NnsMXySOdB2Fe8TyWj2V6zl6bvGWxoF4Nt+i"
        "XCwZOl0DNkkhpZj/XRKuqWDIm3W5niVmg+n2TnoYpy4ZppI3HBlZaq1tY/AyzEWn7ewvR2hucSn/wgwqmaYjiZL0ZedP5fLQvFYu"
        "JXC9wetgcbqkcNBYQEpRDocsAdzUIo2+0WN9Ba9QcjUx4UqRwqQ/b3LCqsAJHSlTKHIszqy8Z+mPdDlsa0ShRzqJRZeRdoib7rrR"
        "XxFoxYqJBvWgqfvt/wA="
    ),
    -15,
).decode("utf-8")
_DEFAULT_MAX_EVIDENCE_ITEMS = 160
_DEFAULT_MAX_RAG_CHUNKS = 5

_FAQ_RELATIONSHIP_CARD_PROMPT = """
FAQ RELATIONSHIP-CARD CONTRACT — this replaces any earlier FAQ instruction that asks you to preserve, map, or reuse raw source FAQ questions.

You are the reasoning and composition stage for FAQPage. These relationship cards (`faqRelationshipCards`) are the only membership candidates. They contain evidence claims, not public-copy templates.

For each selected card, compose a natural customer-decision question and answer in the target locale. Use 2–3 independent cards when the evidence supports them; return fewer when it does not. Every FAQ row must include the exact `id` of one supplied card and may cite only that card's evidence IDs. Cite the evidence of every claim your answer states, not only the one it opens with: a sentence about an ingredient is read against the ingredient claim's evidence, and an answer that names a fact it did not cite is dropped even when the card records that fact. The `id` alone selects the card, and the card supplies that row's intent, so `intent` is your own short note about the row and is never used to choose or validate the card. `cep` is a planning note of the same kind: one phrase in the target locale naming the customer entry point that row answers -- the situation, need, or constraint a shopper arrives in (`아침저녁 매일 쓰는 세안제를 고를 때`, `when makeup has to come off without stinging`). It reaches no published field, so it is never read as copy and the wording of the situation is yours; it may not settle anything your cited evidence does not state, so keep every figure, cause, fit, safety, and superiority conclusion out of it.

Start every question with a real customer situation, concern, goal, skin condition, or routine need, then naturally ask which product, serum, cream, or care choice fits it. When the selected card's `canRecommend` is true, ask what is recommended for that situation rather than what may be worth weighing; when it is false, ask which product fits and never ask what is recommended. The situation may stand wherever the locale puts it, but it has to be there: a bare request for a recommendation names no customer and is rejected. The question may be generic; it does not have to name the product because the answer must naturally name both the brand and product. Name the product exactly as the card's `productName` gives it: that is the published entity, and the recorded title's pack size or option suffix (`… 200g`, `… 90ml`) names a SKU the schema does not publish. Let the selected card determine the substantive customer need, and retain meaningful overlap with that card's claims. Do not make ingredients, proof, study results, application steps, or source wording the topic of the question: those are answer evidence, not an analyst's question headline.

`canRecommend` licenses the recommendation, and that licence — not the position of any sentence — is what decides whether you may offer the product at all. When it is true, write the answer in three parts: a condition naming the buyer's goal or situation, the offer of the brand and product for that condition, then the product's own recorded reason — `{목표·상황 조건절}이라면 {브랜드} {상품}을 추천합니다. {상품}에 담긴 {성분}이 {효능}을 …`, and in English the same three parts in English's own order (`If …, consider {brand} {product}. In {product}, {ingredient} …`). The condition and the offer belong to one opening sentence, and the locale decides whether the condition stands before the product's name or trails it; either order speaks to the reader as long as that sentence says something about the reader's own situation. When the card also supplies a metric claim, a buyer-decision answer reads best as the shopper's own arc: the concern, the product as the choice, what the formula does about it, the recorded result, and whom the source says it suits. Include the parts the card records and leave out the parts it does not. Use an `explicit` formula/effect relationship as one supported relation; when the card supplies only `independent` formula and benefit/effect facts, retain both as separate factual sentences and never invent causal wording. When `canRecommend` is false the row holds no licence: do not invent fit, suitability, or a recommendation, and state the source-backed facts in direct, natural product language instead.

Do not publish an inventory, heading, audit, HowTo, or source-narration question. In particular, do not ask `Which ingredients are listed`, `What benefits are stated`, `What evidence supports this`, `How to use`, `How should it be used`, `How should a result be interpreted`, `What does the page say`, or a rating-only question. Do not copy or reframe raw source FAQ headings merely because they appear in the evidence ledger. A usage or safety card may supplement a stronger decision answer only when its question still starts from a concrete customer routine or concern; never use a bare usage or safety heading as its topic. Do not create a question, answer, card ID, relationship, claim, metric, safety conclusion, target, or usage step that the supplied card does not support.

A measured result names a customer situation. What a study measured — what the product removed, improved, or protected — is the thing a buyer searches for, so that measured subject may be the situation a question starts from, and the answer then carries the figure together with the population, period, and method the card records for it. The figure is evidence for the recommendation, never the question's headline.

Write one clause per fact. A clause says what the claims this row cites record for it, and you compose the clause yourself: the grammar, the connective, the hedge, the possessive and whatever marking the locale needs are yours, so a clause may state a claim in your own words rather than in the claim's. What a clause may never add is a conclusion its cited claims do not record — a figure none of them filed, a cause none of them draws, a fit or suitability none of them states, a safety or superiority verdict, or a comparison. Join two recorded facts with a connective when each clause stands on a claim of its own. List several facts under one predicate only when the card records that predicate for every item listed; otherwise give each item its own clause carrying the outcome that card records for it, because two ingredients sharing a predicate the card records for one of them asserts a joint effect the source never records. Keep the answer on the situation the question asked — name the ingredient or technology the card records, what the card says it does, and the outcome that answers the goal the question stated, and add the recorded result and whom the source says it suits when the card records them — and do not append a fact that answers nothing the question asked merely because the card records it.

A recommending answer must keep two things the card records, or it is dropped. It must retain the customer relation the card cites -- the audience or concern in the terms that card states it, not a rephrasing that drops the relation -- and it must give a reason drawn from that card's formula or effect claims. A recommendation with a customer but no reason, or a reason but no customer, does not survive admission.

A usage answer states the directions the page recorded, as the page wrote them, one recorded step per sentence. Do not compress a procedure into a single paraphrased sentence: the ordered procedure is published as HowTo, so an answer that re-narrates it both repeats that field and states a sequence no single recorded step supports. Where one step answers the question, state that step.

Name an ingredient as an ingredient of this product, not as a fact standing on its own. A reader meeting "판테놀은 …" has to supply the link back to the product; naming it as what the product contains states the link the card records. Each locale has one containment frame and you write that frame: Korean `{상품}에 담긴 {성분}은 …`, English `In {product}, {ingredient} …`. English must use that frame and never `{product} contains {ingredient}` or `{product} features {ingredient}`, because the assertion-frame check reads everything standing in front of the effect as that effect's subject: a containing verb puts the product where the source put the ingredient, and the sentence loses the record that licensed it, while `In {product}, …` leaves the ingredient standing as the subject the source recorded. Say the product once for the group, so the ingredients that follow continue the same account.

An answer's opening condition has to be a condition its own main clause answers. Where the card licenses a recommendation the answer answers "which product fits this situation", so the condition names the situation and the main clause offers the product. Where it licenses none the answer answers a question about the product, so state the fact directly in the product's own voice and write no condition at all: forcing a condition in front of a plain fact produces a sentence whose halves do not agree ("…확인하려면 …은 두 테스트를 완료한 제품입니다"), and that row is dropped. The product's own voice also means the product is what the sentence is about, never the page's act of saying so: write "…을 완료했습니다", not "…을 완료했다고 안내합니다". A reporting verb puts the page in the sentence, and the record filed the fact rather than an announcement of it, so the answer no longer rests on what it cites. This holds for every card, not only for a metric.

Write the question as the buyer's goal or concern and then the request for a product that fits it, and let the answer take that same goal as the condition it is licensed to answer. Both parts are composed in the target locale's own natural phrasing: this contract states what each part must do, not the words any one language uses to do it, and it applies identically in Korean and in English. The two differ only in the containment and condition frames pinned above, which is where a locale's grammar decides where a part stands.

For metrics, write a natural sentence only when the selected card supplies a coherent measured subject, result, timing, method, and qualification. Integrate the result into a direct product sentence; never write that a page, source, result, or study "is stated", "is presented", "is shown", or "is provided". A figure is the one claim you may not put in your own words: carry the card's own wording for what was measured, on whom, over what period, and by what method. A synonym for the method names a measurement the record never describes -- writing `assessment` where the card filed `result` is a study the page did not report -- and the whole row is dropped for that one word even when every other word is the card's. Do not paste OCR/table fragments, study dates, or dangling caveats. Keep question and answer useful for an answer engine: no source narration, no generic category tautology, no mechanical template language, and no bare data lists.

When `faqRecoveryOnly` is true, this is a focused FAQ recovery. Compose FAQ rows only for the exact IDs in `faqRecoveryCardIds`; do not introduce another card, reuse a rejected source heading, or use the retry to change Product.description, WebPage.description, HowTo, or CEP membership.
""".strip()

# Provider-neutral strict JSON Schema for the optional semantic-planning call.
# This is a direct data-port of ``content-planner.ts``'s public runtime export;
# keep property and required-field order stable for provider wire artifacts.
_JSON_PLANNED_FIELD: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "include": {"type": "boolean"},
        "text": {"type": "string"},
        "intent": {"type": "string"},
        "evidenceIds": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "omitReason": {"type": "string"},
    },
    "required": ["include", "text", "intent", "evidenceIds", "confidence", "omitReason"],
}

_JSON_PLANNED_FAQ: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "id": {"type": "string"},
        "include": {"type": "boolean"},
        "question": {"type": "string"},
        "answer": {"type": "string"},
        "intent": {"type": "string"},
        "cep": {"type": "string"},
        "evidenceIds": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "omitReason": {"type": "string"},
    },
    "required": ["id", "include", "question", "answer", "intent", "cep", "evidenceIds", "confidence", "omitReason"],
}

_JSON_PLANNED_HOW_TO_STEP: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "position": {"type": "integer", "minimum": 1},
        "name": {"type": "string"},
        "text": {"type": "string"},
        "evidenceIds": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["position", "name", "text", "evidenceIds"],
}

pdp_geo_content_plan_json_schema: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "locale": {"type": "string", "enum": ["ko-KR", "ja-JP", "en-US", "en-GB"]},
        "productDescription": _JSON_PLANNED_FIELD,
        "webPageDescription": _JSON_PLANNED_FIELD,
        "faq": {"type": "array", "items": _JSON_PLANNED_FAQ},
        "howTo": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "eligible": {"type": "boolean"},
                "ordered": {"type": "boolean"},
                "goal": {"type": "string"},
                "steps": {"type": "array", "items": _JSON_PLANNED_HOW_TO_STEP},
                "evidenceIds": {"type": "array", "items": {"type": "string"}},
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                "omitReason": {"type": "string"},
            },
            "required": ["eligible", "ordered", "goal", "steps", "evidenceIds", "confidence", "omitReason"],
        },
        "cep": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "situation": {"type": "string"},
                    "need": {"type": "string"},
                    "constraint": {"type": "string"},
                    "evidenceIds": {"type": "array", "items": {"type": "string"}},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                },
                "required": ["situation", "need", "constraint", "evidenceIds", "confidence"],
            },
        },
        "warnings": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["locale", "productDescription", "webPageDescription", "faq", "howTo", "cep", "warnings"],
}


def pdp_geo_evidence_key(role: str, text: str) -> str:
    return f"{role}\0{text.lower()}"


def _base36(value: int) -> str:
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    if value == 0:
        return "0"
    output = ""
    while value:
        value, remainder = divmod(value, 36)
        output = alphabet[remainder] + output
    return output


def _stable_hash(value: str) -> str:
    return _base36(js_fnv1a32_unsigned(value))


def create_pdp_geo_evidence_ledger(product: Mapping[str, Any], locale: str) -> list[dict[str, Any]]:
    """Create ordered, deduplicated evidence atoms with stable JS-compatible IDs."""

    items: list[dict[str, Any]] = []
    seen: dict[str, int] = {}

    def add(
        role: str, value: object, source_path: str, confidence: float, provenance: Mapping[str, Any] | None = None
    ) -> None:
        text = clean_text(str(value)) if isinstance(value, str | int | float) and not isinstance(value, bool) else ""
        if not text:
            return
        key = pdp_geo_evidence_key(role, text)
        if key in seen:
            existing = items[seen[key]]
            image_urls = [*as_list(existing.get("imageUrls")), *as_list(as_dict(provenance).get("imageUrls"))]
            deduped = _unique_strings([str(url) for url in image_urls])
            if deduped:
                existing["imageUrls"] = deduped
            current_confidence = existing.get("ocrConfidence")
            incoming = as_dict(provenance).get("ocrConfidence")
            if isinstance(incoming, int | float) and not isinstance(incoming, bool):
                existing["ocrConfidence"] = (
                    min(float(current_confidence), float(incoming))
                    if isinstance(current_confidence, int | float)
                    else incoming
                )
            return
        atom: dict[str, Any] = {
            "id": f"ev-{role}-{_stable_hash(f'{source_path}\0{text}')}",
            "role": role,
            "text": text,
            "sourcePath": source_path,
            "locale": locale,
            "productScope": "product",
            "confidence": confidence,
        }
        data = as_dict(provenance)
        images = _unique_strings([str(item) for item in as_list(data.get("imageUrls")) if isinstance(item, str)])
        if images:
            atom["imageUrls"] = images
        if isinstance(data.get("ocrConfidence"), int | float) and not isinstance(data.get("ocrConfidence"), bool):
            atom["ocrConfidence"] = data["ocrConfidence"]
        seen[key] = len(items)
        items.append(atom)

    def add_analyzed(value: object, path: str, confidence: float, provenance: Mapping[str, Any] | None = None) -> None:
        text = clean_text(str(value)) if isinstance(value, str | int | float) and not isinstance(value, bool) else ""
        if not text:
            return
        inference = infer_pdp_evidence_roles_for_ledger(text)
        role = str(inference["primaryRole"])
        role = "source" if role == "safety" else role
        add(role, text, path, confidence if role == "source" else min(0.89, confidence + 0.1), provenance)

    for field, role, confidence in (
        ("name", "identity", 1),
        ("originalName", "identity", 1),
        ("brand", "identity", 1),
        ("category", "identity", 0.95),
        ("description", "description", 0.95),
    ):
        add(role, product.get(field), f"product.{field}", confidence)
    for field, role, confidence in (
        ("benefits", "benefit", 0.95),
        ("effects", "effect", 0.95),
        ("ingredients", "ingredient", 0.95),
    ):
        for index, value in enumerate(as_list(product.get(field))):
            add(role, value, f"product.{field}[{index}]", confidence)
    semantic = as_dict(product.get("semanticFacts"))
    for field, role in (
        ("benefits", "benefit"),
        ("effects", "effect"),
        ("ingredients", "ingredient"),
        ("skinTypes", "audience"),
    ):
        for index, value in enumerate(as_list(semantic.get(field))):
            add(role, value, f"product.semanticFacts.{field}[{index}]", 0.95)
    for field, role, confidence in (
        ("usage", "usage", 0.98),
        ("metrics", "metric", 0.98),
        ("options", "commerce", 0.9),
    ):
        for index, value in enumerate(as_list(product.get(field))):
            add(role, value, f"product.{field}[{index}]", confidence)
    price = as_dict(product.get("price"))
    add("commerce", price.get("raw"), "product.price.raw", 1)
    for index, item in enumerate(as_list(product.get("faq"))):
        data = as_dict(item)
        add("faq", f"{clean_text(data.get('question'))}\n{clean_text(data.get('answer'))}", f"product.faq[{index}]", 1)
    reviews = as_dict(product.get("reviews"))
    for index, item in enumerate(as_list(reviews.get("items"))):
        add("review", as_dict(item).get("body"), f"product.reviews.items[{index}].body", 0.85)
    for index, value in enumerate(as_list(reviews.get("keywords"))):
        add("review", value, f"product.reviews.keywords[{index}]", 0.75)
    if reviews.get("rating") is not None or reviews.get("reviewCount") is not None:
        add(
            "review",
            f"rating={reviews.get('rating', 'unknown')}; reviewCount={reviews.get('reviewCount', 'unknown')}",
            "product.reviews.summary",
            1,
        )
    for field, role in (
        ("usageSteps", "usage"),
        ("safetyTests", "source"),
    ):
        for index, value in enumerate(as_list(semantic.get(field))):
            add(role, value, f"product.semanticFacts.{field}[{index}]", 0.95 if field != "safetyTests" else 0.98)
    for index, value in enumerate(as_list(semantic.get("evidenceSentences"))):
        add_analyzed(value, f"product.semanticFacts.evidenceSentences[{index}]", 0.9)
    for index, claim in enumerate(as_list(semantic.get("metricClaims"))):
        data = as_dict(claim)
        text = _format_metric_claim(data)
        provenance = {"imageUrls": as_list(data.get("imageUrls"))} if data.get("imageUrls") else None
        add("metric", text, f"product.semanticFacts.metricClaims[{index}]", 0.98, provenance)
        rendered = render_structured_table_metric_sentence(
            data,
            locale,
            subject=product_entity_reference(
                product, product_title_without_sku_qualifier(clean_text(product.get("name"))), locale
            ),
        )
        if rendered:
            # A table/OCR row is source evidence, not publishable prose.  The
            # renderer emits this atom only after every displayed component
            # has been found in that row, so the final proofreader can retain
            # its normal exact-sentence provenance contract.
            add("metric", rendered, f"product.semanticFacts.metricClaims[{index}].rendered", 0.98, provenance)
        source = clean_text(data.get("sourceText")) or clean_text(data.get("sentence"))
        if source and source != text:
            add("source", source, f"product.semanticFacts.metricClaims[{index}].sourceText", 0.9, provenance)
    # One study's results are published as one sentence, so that sentence needs
    # an atom of its own: the proofreader proves a published sentence against
    # the ledger, and a merged sentence matches no single claim's rendering.
    measured_claims = [
        record
        for raw in as_list(semantic.get("metricClaims"))
        if (record := as_dict(raw)) and clean_text(record.get("value"))
    ]
    merged_metric = render_merged_measured_result_metric(
        measured_claims,
        locale,
        subject=product_entity_reference(
            product, product_title_without_sku_qualifier(clean_text(product.get("name"))), locale
        ),
    )
    if merged_metric:
        add("metric", merged_metric, "product.semanticFacts.metricClaims.merged", 0.98, None)
    for index, raw_link in enumerate(as_list(semantic.get("ingredientBenefitLinks"))):
        link = as_dict(raw_link)
        provenance = {"imageUrls": as_list(link.get("imageUrls"))} if link.get("imageUrls") else None
        add("ingredient", link.get("ingredient"), f"product.semanticFacts.ingredientBenefitLinks[{index}].ingredient", 0.94, provenance)
        source = clean_text(link.get("sourceText")) or clean_text(link.get("sentence"))
        if not source:
            source = "; ".join(
                value
                for value in (clean_text(link.get("ingredient")), clean_text(link.get("benefit")), clean_text(link.get("effect")))
                if value
            )
        add("source", source, f"product.semanticFacts.ingredientBenefitLinks[{index}]", 0.92, provenance)
        # The extractor files both the line the page printed and the sentence
        # it reads that line as.  A relationship card offers the read sentence
        # -- it states one ingredient where the line states two -- so the
        # ledger must carry it too, or a model answer written from the card can
        # never be proved.  It is admitted only when it adds no word the line
        # did not carry, which is grammar and nothing else.
        reconstructed = clean_text(link.get("sentence"))
        if (
            reconstructed
            and reconstructed != source
            and states_only_what_the_source_states(reconstructed, source)
        ):
            add(
                "source",
                reconstructed,
                f"product.semanticFacts.ingredientBenefitLinks[{index}].sentence",
                0.92,
                provenance,
            )
    for index, raw_citation in enumerate(as_list(semantic.get("citations"))):
        citation = as_dict(raw_citation)
        bibliographic = "; ".join(
            value
            for value in (
                clean_text(citation.get("type")),
                clean_text(citation.get("title")),
                clean_text(citation.get("publisher")),
                clean_text(citation.get("author")),
                clean_text(citation.get("publishedAt")),
                clean_text(citation.get("url")),
                clean_text(citation.get("finding")),
            )
            if value
        )
        provenance = {"imageUrls": as_list(citation.get("imageUrls"))} if citation.get("imageUrls") else None
        add("source", clean_text(citation.get("sourceText")) or bibliographic, f"product.semanticFacts.citations[{index}]", 0.98, provenance)
    for index, value in enumerate(as_list(product.get("sourceTexts"))):
        text = clean_text(value)
        meta = as_dict(as_dict(product.get("sourceTextMeta")).get(text))
        if _is_review_derived_ledger_source_text(text, product):
            add("review", text, f"product.sourceTexts[{index}]", 0.82, meta)
        elif contains_serialized_metadata(text):
            add("source", text, f"product.sourceTexts[{index}]", 0.72, meta)
        else:
            add_analyzed(text, f"product.sourceTexts[{index}]", 0.72, meta)
    return items


def _is_review_derived_ledger_source_text(value: str, product: Mapping[str, Any]) -> bool:
    """Keep review-origin source text from being recast as product claims.

    This is the same provenance gate used by the retained planner before it
    classifies a broad ``sourceTexts`` value.  A review copied into both the
    review section and source text retains the review atom already recorded
    above instead of becoming a benefit, effect, or usage instruction.
    """

    candidate = _normalize_ledger_match(value)
    if not candidate:
        return False
    if re.search(r"(?:customer\s+review|reviewer|고객\s*리뷰|구매\s*후기|리뷰\s*(?:내용|작성)|カスタマーレビュー)", value, re.I):
        return True
    reviews = as_dict(product.get("reviews"))
    values = [
        *(clean_text(as_dict(item).get("body")) for item in as_list(reviews.get("items"))),
        *(clean_text(item) for item in as_list(reviews.get("keywords"))),
    ]
    for review in values:
        key = _normalize_ledger_match(review)
        if key and (candidate == key or (min(len(candidate), len(key)) >= 12 and (candidate in key or key in candidate))):
            return True
    return False


def _normalize_ledger_match(value: object) -> str:
    return re.sub(r"[^\w]+", " ", clean_text(value).casefold()).strip()


def _format_metric_claim(claim: Mapping[str, Any]) -> str:
    outcome = next(
        (clean_text(claim.get(key)) for key in ("label", "subject", "metric") if clean_text(claim.get(key))), ""
    )
    value, unit = clean_text(claim.get("value")), clean_text(claim.get("unit"))
    measured = value if not unit or value.endswith(unit) else f"{value}{unit}"
    if not outcome or not measured:
        return clean_text(claim.get("sentence")) or clean_text(claim.get("sourceText"))
    contexts = [
        f"{key}={clean_text(claim.get(key))}"
        for key in (
            "direction",
            "timing",
            "baseline",
            "comparator",
            "sample",
            "period",
            "method",
            "institution",
            "evidenceGroup",
            "caveat",
        )
        if clean_text(claim.get(key))
    ]
    return "; ".join([f"{outcome}: {measured}", *contexts])


_METRIC_DATE_RANGE = re.compile(
    r"(?P<start_year>(?:19|20)\d{2})[./-](?P<start_month>\d{1,2})[./-](?P<start_day>\d{1,2})"
    r"\s*(?:~|to|–|—|-|부터|에서)\s*"
    r"(?P<end_year>(?:19|20)\d{2})[./-](?P<end_month>\d{1,2})[./-](?P<end_day>\d{1,2})",
    re.IGNORECASE,
)
_METRIC_TABLE_METHOD = re.compile(r"instrumental|clinical|assessment|evaluation|test|study|시험|테스트|평가", re.IGNORECASE)
_METRIC_TABLE_SAMPLE = re.compile(
    r"\d+\s*(?:women|men|users?|subjects?|participants?|people|명|인)\b|\d+\s*명|대상", re.IGNORECASE
)
_METRIC_TABLE_MEASUREMENT = re.compile(r"\d+(?:[.,]\d+)?\s*(?:[%％]|배|points?|times|fold)", re.IGNORECASE)
_ENGLISH_METRIC_DIRECTIONS = {
    "increased": "increased",
    "improved": "improved",
    "reduced": "reduced",
    "decreased": "decreased",
    "recovered": "recovered",
    "remained": "remained",
    "lasted": "lasted",
}
_KOREAN_METRIC_DIRECTIONS = {
    "개선": "개선되었습니다",
    "증가": "증가했습니다",
    "향상": "향상되었습니다",
    "감소": "감소했습니다",
    "완화": "완화되었습니다",
    "회복": "회복되었습니다",
    "상승": "상승했습니다",
    "저하": "저하되었습니다",
    "지속": "지속되었습니다",
}
_ENGLISH_MONTH_NAMES = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)


ADJACENT_MEASURED_QUANTITIES = re.compile(
    r"[+\-\u2212]?\d+(?:[.,]\d+)?\s*(?:[%\uff05]|\ubc30|x|times?|fold)"
    r"(?:\s*[,/\u00b7;]?\s*[+\-\u2212\u00b1*\uff0a\u203b\u00b7\u2022]?\s*\d+(?:[.,]\d+)?\s*(?:[%\uff05]|\ubc30|x|times?|fold))+",
    re.IGNORECASE,
)


def is_raw_metric_table_fragment(value: str) -> bool:
    """Recognize a compact OCR/table row without recasting ordinary source prose."""

    text = clean_text(value)
    if not text:
        return False
    words = re.findall(r"[A-Za-z]{2,}", text)
    mostly_all_caps = len(words) >= 2 and sum(word.isupper() for word in words) / len(words) >= 0.8
    tabular_delimiter = bool(re.search(r"(?:\t|\||\s{3,})", text))
    row_signals = sum(
        (
            _METRIC_DATE_RANGE.search(text) is not None,
            _METRIC_TABLE_METHOD.search(text) is not None,
            _METRIC_TABLE_SAMPLE.search(text) is not None,
            _METRIC_TABLE_MEASUREMENT.search(text) is not None,
        )
    )
    ocr_footnote_row = "*" in text and row_signals >= 3
    # A chart flattens into a run of figures standing side by side.  Prose
    # binds each figure to what it measures, so figures that sit adjacent with
    # nothing between them are the cells of a row whose layout was lost -- the
    # shape a bar chart takes once its line breaks are gone.  Reading that as
    # ordinary prose published a chart's whole row as one claim; reading it as
    # a row sends it to the renderer that states what each figure measures.
    charted_row = ADJACENT_MEASURED_QUANTITIES.search(text) is not None
    return tabular_delimiter or mostly_all_caps or ocr_footnote_row or charted_row or (
        not re.search(r"[.!?。！？]\s*$", text) and row_signals >= 3
    )


def render_structured_table_metric_sentence(
    claim: Mapping[str, Any], locale: str, *, subject: str = ""
) -> str:
    """Render a table-like source metric only when each public component is explicit.

    ``subject`` is the product the page measured, supplied by the caller that
    knows it.  A measured result whose predicate the page printed without a
    subject needs it to become a sentence, and an answer engine lifting that
    sentence then still knows what was measured.
    """

    source = clean_text(claim.get("sourceText")) or clean_text(claim.get("sentence"))
    outcome = next((clean_text(claim.get(key)) for key in ("label", "subject", "metric") if clean_text(claim.get(key))), "")
    value, unit, direction = clean_text(claim.get("value")), clean_text(claim.get("unit")), clean_text(claim.get("direction"))
    timing, period = clean_text(claim.get("timing")), clean_text(claim.get("period"))
    sample, method = clean_text(claim.get("sample")), clean_text(claim.get("method"))
    institution, caveat = clean_text(claim.get("institution")), clean_text(claim.get("caveat"))
    if not source or not is_raw_metric_table_fragment(source) or not outcome or not value or not unit:
        return ""
    if not _metric_source_contains_measurement(source, value, unit):
        return ""
    measurement = _metric_measurement(value, unit)
    # A page can write the outcome *around* its number ("색조 메이크업 97.1%
    # 세정"), so the outcome is stated by the source even though its words are
    # not contiguous there.  Reading only the contiguous form rejected the
    # page's own phrasing and left the strongest measured result unpublished.
    result_phrase = _measured_result_phrase(source, claim, measurement)
    if not _metric_source_contains_text(source, outcome) and not result_phrase:
        return ""
    for candidate in (period, sample, method, institution):
        if candidate and not _metric_source_contains_text(source, candidate):
            return ""
    if timing and not _metric_source_contains_timing(source, timing):
        return ""
    # A comparison needs comparison grammar: flattened into an unqualified
    # result it would assert of the product what the page stated only against
    # another series.  Korean has that grammar here, so a charted comparison is
    # published as the comparison it is instead of being dropped.
    if clean_text(claim.get("baseline")) or clean_text(claim.get("comparator")):
        if locale.casefold().startswith("ko"):
            return _render_korean_comparative_metric(subject, claim, measurement, source)
        if locale.casefold().startswith("en"):
            return _render_english_comparative_metric(subject, claim, measurement, source)
        return ""
    date_range = _metric_date_range(period) if period else None
    # A period is not always a date range.  A results panel states how long the
    # product was used ("after 4 weeks of use"), which is the same fact the
    # timing slot carries, so it is read as the timing rather than discarded --
    # requiring dates dropped every panel whose study ran for a duration.
    if period and date_range is None and not timing and _METRIC_DURATION_PERIOD.fullmatch(period):
        timing, period = period, ""
    if period and date_range is None and not timing:
        return ""
    if locale.casefold().startswith("en"):
        public_timing, public_method, public_caveat = _english_structured_metric_public_context(
            source,
            timing,
            method,
            caveat if _metric_source_contains_text(source, caveat) else "",
        )
        share_predicate = _english_metric_share_predicate(source, measurement, outcome, unit)
        if share_predicate:
            if not public_timing or not sample:
                return ""
            return _render_english_participant_share_metric(
                outcome,
                measurement,
                share_predicate,
                public_timing,
                sample,
                public_method,
                institution,
                public_caveat,
            )
        direction_word = _ENGLISH_METRIC_DIRECTIONS.get(direction.casefold())
        if (
            not direction_word
            or _english_metric_outcome_repeats_direction(outcome, direction_word)
            or not _english_metric_has_explicit_delta_relation(source, outcome, measurement, direction_word)
        ):
            return _render_english_measured_result_metric(
                subject,
                outcome,
                measurement,
                public_timing,
                date_range,
                sample,
                public_method,
                institution,
                public_caveat,
            )
        return _render_english_structured_metric(
            outcome, measurement, direction_word, public_timing, date_range, sample, public_method, institution,
            public_caveat,
        )
    if locale.casefold().startswith("ko"):
        direction_word = _KOREAN_METRIC_DIRECTIONS.get(direction)
        if not direction_word:
            return _render_korean_measured_result_metric(
                subject,
                _korean_measured_result_clause(subject, claim, measurement),
                result_phrase,
                timing,
                date_range,
                sample,
                method,
                institution,
                caveat if _metric_source_contains_text(source, caveat) else "",
            )
        return _render_korean_structured_metric(
            outcome, measurement, direction_word, timing, date_range, sample, method, institution,
            caveat if _metric_source_contains_text(source, caveat) else "",
        )
    return ""


_KOREAN_EXISTENCE_FOOTNOTE = re.compile(r"^(?P<subject>.+?)\s*있음$")


def _public_caveat_clause(caveat: str, locale: str) -> str:
    """Render a source footnote as a clause the locale can read as a statement.

    A page prints its qualification as a nominalized predicate -- "개인차 있음",
    "…불명확함" -- because a footnote sits beside the claim rather than in it.
    Published as its own sentence it asserts nothing, so the words stay and the
    predicate is conjugated: the same fact, in the grammar of the market that
    reads it.  Nothing is added but the ending Korean needs to finish a clause.
    """

    text = clean_text(caveat).rstrip(".。！？!?")
    if not text or not locale.casefold().startswith("ko"):
        return text
    existence = _KOREAN_EXISTENCE_FOOTNOTE.match(text)
    if existence:
        subject = existence.group("subject").strip()
        return f"단, {subject}{_korean_metric_particle(subject, '이', '가')} 있을 수 있습니다"
    conjugated = re.sub(r"임$", "입니다", re.sub(r"함$", "합니다", text))
    return f"단, {conjugated}" if conjugated != text else text


def _caveat_stands_as_its_own_statement(caveat: str, locale: str) -> bool:
    """Return whether the locale reads this footnote as a statement by itself."""

    text = clean_text(caveat)
    if not text:
        return False
    return is_korean_complete_sentence(text) if re.search(r"[가-힣]", text) else is_complete_sentence(text)


def _metric_sentence_with_caveat(sentence: str, caveat: str, locale: str) -> str:
    """Close a measured claim on a caveat that cannot stand without it.

    An answer engine lifts one sentence.  A footnote that is already a
    statement -- "Individual results may vary." -- survives being lifted on its
    own, so it stays a sentence beside the claim.  A nominalized footnote --
    "개인차 있음", "With daily use" -- asserts nothing once separated from what
    it qualifies, so it closes inside the claim, where whatever is lifted
    carries both.  What decides is whether the locale reads the caveat as a
    statement, not which locale it is.
    """

    text = clean_text(sentence)
    if not clean_text(caveat):
        return text
    if _caveat_stands_as_its_own_statement(caveat, locale):
        return f"{text} {_metric_sentence(caveat)}".strip()
    note = _public_caveat_clause(caveat, locale)
    if not note:
        return text
    return f"{text.rstrip('.。！？!?')}({note})."


def _metric_source_contains_measurement(source: str, value: str, unit: str) -> bool:
    if value.casefold().endswith(unit.casefold()):
        measurement = re.escape(value)
        if unit in {"%", "％"}:
            measurement = re.escape(value[: -len(unit)]) + r"\s*[%％]"
    else:
        unit_pattern = r"[%％]" if unit in {"%", "％"} else re.escape(unit)
        measurement = rf"{re.escape(value)}\s*{unit_pattern}"
    return re.search(rf"(?<![\w.,]){measurement}(?![\d.,])", source, re.IGNORECASE) is not None


def _source_states_timing_anchors(source: str, timing: str) -> bool:
    """Return whether the source states every word of a timing, in its own order.

    A page writes a before/after pair as two phrases and extraction joins them
    into one; the joined spelling is the same timing, written once.  Requiring
    each word to appear, and in the order the page put them, keeps that from
    admitting a timing the page never stated -- the words alone, in any order,
    would let ``사용 후 2주`` stand in for ``2주 후 사용``.
    """

    words = [word for word in re.findall(r"\w+", clean_text(timing)) if word]
    if len(words) < 2:
        return False
    # The page may repeat a word between the anchors ("사용 전 사용 후"), so the
    # gap is bounded rather than closed, and it never crosses a sentence end.
    pattern = r"[^.!?。！？]{0,24}?".join(re.escape(word) for word in words)
    return re.search(pattern, source, re.IGNORECASE) is not None


def _metric_source_contains_text(source: str, value: str) -> bool:
    def key(text: str) -> str:
        return re.sub(r"[^\w가-힣]+", " ", clean_text(text).casefold()).strip()

    candidate = key(value)
    return bool(candidate and candidate in key(source))


def _metric_source_contains_timing(source: str, timing: str) -> bool:
    """Accept a normalized duration only when its split source anchors are all explicit."""

    if _metric_source_contains_text(source, timing):
        return True
    # Extraction writes one timing where the page wrote two ("사용 전/후" for
    # "사용 전 사용 후"), and reading only the joined spelling made the
    # pipeline's own normalization look like a timing the page never stated.
    # The anchors still have to be there, in the page's own order.
    if _source_states_timing_anchors(source, timing):
        return True
    without_daily_use = re.sub(r"\bdaily\s+use\b", "use", timing, flags=re.IGNORECASE)
    if without_daily_use == timing:
        return False
    base_pattern = _metric_source_phrase_pattern(without_daily_use)
    return bool(
        base_pattern
        and re.search(rf"{base_pattern}[^.!?。！？]{{0,200}}\bdaily\s+use\b", source, re.IGNORECASE)
    )


def _english_metric_share_predicate(source: str, measurement: str, outcome: str, unit: str) -> str:
    """Identify a source-stated participant-share result without recasting it as a numeric delta."""

    if unit not in {"%", "％"}:
        return ""
    measurement_pattern = _metric_measurement_pattern(measurement)
    outcome_pattern = _metric_source_phrase_pattern(outcome)
    if not measurement_pattern or not outcome_pattern:
        return ""
    participant_prefix = r"(?:\s+(?:of|the|all|users?|women|men|participants?|subjects?|respondents?|\d+)){0,6}\s*"
    if re.search(
        rf"{measurement_pattern}{participant_prefix}\b(?:agree|agrees|agreed)\b\s+(?:that\s+)?{outcome_pattern}",
        source,
        re.IGNORECASE,
    ):
        return "agreed"
    if re.search(
        rf"{measurement_pattern}{participant_prefix}\b(?:show|shows|showed|saw|reported)\b\s+{outcome_pattern}",
        source,
        re.IGNORECASE,
    ):
        return "showed"
    return ""


def _english_metric_outcome_repeats_direction(outcome: str, direction: str) -> bool:
    """Reject a participial outcome before it can become ``reduced … reduced`` prose."""

    words = re.findall(r"[A-Za-z]+", clean_text(outcome).casefold())
    return bool(words and words[0] == direction.casefold())


def _english_metric_has_explicit_delta_relation(source: str, outcome: str, measurement: str, direction: str) -> bool:
    """Permit numeric-delta grammar only when its own source row states that relation.

    A percentage beside a sample may be a participant share rather than a
    magnitude.  The participant-share path above handles that form only when
    the source supplies its predicate.  This separate guard keeps the delta
    renderer from assigning a relation to an otherwise unconnected table row.
    """

    outcome_pattern = _metric_source_phrase_pattern(outcome)
    measurement_pattern = _metric_measurement_pattern(measurement)
    if not outcome_pattern or not measurement_pattern:
        return False
    direction_pattern = re.escape(clean_text(direction))
    natural_delta_relation = re.search(
        rf"{outcome_pattern}\W+{direction_pattern}(?:\s+by)?\W*{measurement_pattern}",
        source,
        re.IGNORECASE,
    )
    if natural_delta_relation is not None:
        return True
    # A complete table row can state the same relationship in column order
    # (outcome | measurement | direction), rather than sentence order.  Each
    # component must be adjacent through explicit table separators, so this
    # cannot turn a distant percentage or participant-share phrase into a
    # numeric-delta claim.
    table_separator = r"(?:\||\t|\s{3,})"
    return re.search(
        rf"{outcome_pattern}\s*{table_separator}\s*{measurement_pattern}\s*{table_separator}\s*{direction_pattern}\b",
        source,
        re.IGNORECASE,
    ) is not None


def _metric_measurement_pattern(measurement: str) -> str:
    """Match the display form of one percentage without making another row eligible."""

    text = clean_text(measurement)
    if text.endswith(("%", "％")):
        return re.escape(text[:-1]) + r"\s*[%％]"
    return re.escape(text)


def _metric_source_phrase_pattern(value: str) -> str:
    """Match a source phrase across ordinary OCR punctuation only.

    Word characters carry the phrase in every locale this corpus publishes, so
    the token scan reads them rather than the Latin alphabet alone; a Korean
    phrase otherwise compiled to an empty pattern that matched everywhere.
    """

    tokens = re.findall(r"\w+", clean_text(value))
    return r"\W+".join(re.escape(token) for token in tokens)


def _metric_measurement(value: str, unit: str) -> str:
    return value if value.casefold().endswith(unit.casefold()) else f"{value}{unit}"


def _measured_thing_beyond_subject(label: str, subject: str) -> str:
    """Return the part of a claim's label that names what was measured.

    A classifier files the whole outcome as one label ("색조 메이크업 세정")
    beside the subject the page printed ("집앞 나갈때 가볍게 하는 색조
    메이크업").  What the label adds over the subject is the thing measured --
    the word the page printed after its number -- so it is read off the label
    rather than expected in a separate field.  A layout-derived claim already
    carries that field and never reaches here.

    Word order is the label's own, and a label that adds nothing to the
    subject names no measured thing.
    """

    if not label or not subject:
        return ""
    stated = {
        strip_korean_particle(token) if re.search(r"[가-힣]", token) else token.casefold()
        for token in re.findall(r"[A-Za-z0-9%]+|[가-힣]+", subject)
    }
    tail = [
        token
        for token in re.findall(r"[A-Za-z0-9%]+|[가-힣]+", label)
        if (strip_korean_particle(token) if re.search(r"[가-힣]", token) else token.casefold()) not in stated
    ]
    return " ".join(tail)


def _measured_result_phrase(source: str, claim: Mapping[str, Any], measurement: str) -> str:
    """Return the words the source itself wraps around this claim's number.

    A measurement is not always a change.  A page also reports how much of
    something a product acted on -- what share of makeup it removed, what share
    of debris it lifted -- and writes it as one phrase whose middle is the
    number: subject, measurement, then the thing measured.  The value *is* the
    outcome there, so there is no direction to name.

    The phrase is returned only when the source states it as a run, so what
    gets published is the page's own wording rather than a phrase assembled
    from schema fields that the page never put side by side.
    """

    subject = clean_text(claim.get("subject"))
    metric = clean_text(claim.get("metric")) or _measured_thing_beyond_subject(
        clean_text(claim.get("label")), subject
    )
    if not subject or not metric or not measurement:
        return ""
    subject_pattern = _metric_source_phrase_pattern(subject)
    metric_pattern = _metric_source_phrase_pattern(metric)
    if not subject_pattern or not metric_pattern:
        return ""
    match = re.search(
        rf"{subject_pattern}\W*{_metric_measurement_pattern(measurement)}\W*{metric_pattern}",
        source,
        re.IGNORECASE,
    )
    return clean_text(match.group()) if match is not None else ""


def _metric_date_range(value: str) -> tuple[tuple[int, int, int], tuple[int, int, int]] | None:
    """Read the dates a period states, whatever the page labelled them.

    A page prints the label with the range ("시험기간 2025.07.21~2025.08.22"),
    and the label is not a date.  Requiring the whole field to be nothing but
    the range rejected every period a page actually wrote, which then failed
    the caller's "a period must resolve to real dates" check and dropped the
    strongest measured result the source had.
    """

    match = _METRIC_DATE_RANGE.search(clean_text(value))
    if match is None:
        return None
    start = tuple(int(match.group(f"start_{part}")) for part in ("year", "month", "day"))
    end = tuple(int(match.group(f"end_{part}")) for part in ("year", "month", "day"))
    if any(month not in range(1, 13) or day not in range(1, 32) for _, month, day in (start, end)):
        return None
    return cast(tuple[int, int, int], start), cast(tuple[int, int, int], end)


def _render_english_structured_metric(
    outcome: str,
    measurement: str,
    direction: str,
    timing: str,
    date_range: tuple[tuple[int, int, int], tuple[int, int, int]] | None,
    sample: str,
    method: str,
    institution: str,
    caveat: str,
) -> str:
    if timing and not re.match(r"(?:after|before|during|over|within|following)\b", timing, re.IGNORECASE):
        return ""
    if institution and not method:
        return ""
    scope = ""
    rendered_method = _english_metric_method_phrase(method)
    if rendered_method:
        article = "" if re.match(r"(?:an?|the)\b", rendered_method, re.IGNORECASE) else "the "
        scope = f"in {article}{rendered_method}"
        if institution:
            scope += f" at {institution}"
        if sample:
            scope += f" of {sample}"
    elif sample:
        scope = f"among {sample}"
    period = _english_metric_period(date_range) if date_range else ""
    if period:
        scope = f"{scope} conducted {period}" if scope else f"during the period {period}"
    prefix = f"{_capitalize_metric_outcome(timing)}, " if timing else ""
    sentence = f"{prefix}{_capitalize_metric_outcome(outcome)} {direction} by {measurement}"
    if scope:
        sentence += f" {scope}"
    sentence += "."
    return _metric_sentence_with_caveat(sentence, caveat, "en-US")


_METRIC_DURATION_PERIOD = re.compile(
    r"(?:for|over|after|within|following)\s+\d+\s*(?:weeks?|days?|months?|hours?)(?:\s+of\s+use)?"
    r"|\d+\s*(?:weeks?|days?|months?|hours?)\s+of\s+use"
    r"|\d+\s*(?:주|일|개월|시간)\s*(?:간|동안)?\s*(?:사용)?",
    re.IGNORECASE,
)


def _english_metric_method_phrase(method: str) -> str:
    """Set a footnote-cased method in sentence case.

    A panel prints its method as a heading ("Instrumental result"), and a
    heading's capital is how the page set the line, not a word of the claim.
    Inside a sentence that capital reads as a proper name, so it is lowered.
    An acronym is left alone, and no word is changed.
    """

    text = clean_text(method)
    if not text or text.isupper():
        return text
    return f"{text[:1].lower()}{text[1:]}"


def _render_english_measured_result_metric(
    subject: str,
    predicate: str,
    measurement: str,
    timing: str,
    date_range: tuple[tuple[int, int, int], tuple[int, int, int]] | None,
    sample: str,
    method: str,
    institution: str,
    caveat: str,
) -> str:
    """Render a measured result the page printed as a predicate, not as a delta.

    A results panel prints what the product did and how much -- "IMPROVES THE
    LOOK OF SKIN ELASTICITY", "+5.9%" -- without naming a direction word.  The
    delta renderer needs one, so these results were dropped, and a page lost
    the strongest evidence it had while nothing took its place.

    Nothing is composed here beyond the subject the caller supplies and the
    study scope the same row states.  The predicate stays in the page's own
    words: capitals are how a panel prints, not what it says, so an all-capital
    predicate is set in lower case and no word is changed.  The scope is
    published only when the row names who was measured, so a bare figure never
    reaches public copy without its population.
    """

    if not subject or not sample or not measurement:
        return ""
    if not english_subjectless_predicate(predicate):
        return ""
    if timing and not re.match(r"(?:after|before|during|over|within|following)\b", timing, re.IGNORECASE):
        return ""
    if institution and not method:
        return ""
    # The scope is fronted so the product is not the first word of a second
    # consecutive sentence.  A description that opens every sentence on the
    # same name reads as a filled-in template, and the name still stands in
    # the sentence, where a citation keeps it.
    scope = _english_metric_participant_scope(_english_metric_method_phrase(method), sample, institution)
    if not scope:
        return ""
    period = _english_metric_period(date_range) if date_range else ""
    if period:
        scope = f"{scope} conducted {period}"
    rendered = predicate.lower() if predicate.isupper() else f"{predicate[:1].lower()}{predicate[1:]}"
    sentence = f"{scope}, {subject} {rendered} by {measurement}"
    if timing:
        sentence += f" {timing}"
    sentence = f"{re.sub(r'\s+', ' ', sentence).strip()}."
    return _metric_sentence_with_caveat(sentence, caveat, "en-US")


def _render_english_participant_share_metric(
    outcome: str,
    measurement: str,
    predicate: str,
    timing: str,
    sample: str,
    method: str,
    institution: str,
    caveat: str,
) -> str:
    """Write a source-stated share result as a readable study sentence, not an OCR row."""

    scope = _english_metric_participant_scope(method, sample, institution)
    if not scope:
        return ""
    outcome_clause = _lowercase_metric_outcome(outcome)
    if predicate == "agreed":
        result = f"{measurement} agreed that {outcome_clause}"
    else:
        result = f"{measurement} showed {outcome_clause}"
    sentence = f"{scope}, {result} {_lowercase_metric_outcome(timing)}."
    if caveat and not _metric_caveat_repeats_timing(caveat, timing):
        sentence = _metric_sentence_with_caveat(sentence, caveat, "en-US")
    return sentence


def _english_structured_metric_public_context(
    source: str, timing: str, method: str, caveat: str
) -> tuple[str, str, str]:
    """Repair only source-local OCR grammar before public metric rendering.

    A footnote such as ``self-assessment from clinical, 32 women, with daily
    use`` does not establish a clinical study. Preserve the stated
    self-assessment modality, remove only its dangling connective, and fold a
    same-footnote daily-use qualifier into an ``… of use`` duration rather
    than publishing an isolated second sentence.
    """

    public_method = re.sub(
        r"\bself[\s-]*assessment\s+from\s+clinical\b",
        "self-assessment",
        clean_text(method),
        count=1,
        flags=re.IGNORECASE,
    )
    public_timing = clean_text(timing)
    public_caveat = clean_text(caveat)
    if not _english_metric_has_local_daily_use_footnote(source, method, public_caveat):
        return public_timing, public_method, public_caveat
    if re.search(r"\bdaily\s+use\b", public_timing, re.IGNORECASE):
        return public_timing, public_method, ""
    if re.search(r"\bof\s+use\b", public_timing, re.IGNORECASE):
        public_timing = re.sub(r"\bof\s+use\b", "of daily use", public_timing, count=1, flags=re.IGNORECASE)
        return public_timing, public_method, ""
    if re.search(r"\b(?:after|before|during|over|within|following)\s+\d+\s+(?:days?|weeks?|months?)\b", public_timing, re.I):
        return f"{public_timing} of daily use", public_method, ""
    return public_timing, public_method, public_caveat


def _english_metric_has_local_daily_use_footnote(source: str, method: str, caveat: str) -> bool:
    """Require the method and daily-use note to share one source footnote span."""

    if not re.fullmatch(r"with\s+daily\s+use[.!?。！？]?", clean_text(caveat), re.IGNORECASE):
        return False
    method_pattern = _metric_source_phrase_pattern(method)
    caveat_pattern = _metric_source_phrase_pattern(caveat)
    return bool(
        method_pattern
        and caveat_pattern
        and re.search(rf"{method_pattern}[^.!?。！？]{{0,200}}{caveat_pattern}", source, re.IGNORECASE)
    )


def _english_metric_participant_scope(method: str, sample: str, institution: str) -> str:
    """Keep the method/sample attribution in one natural, source-bound phrase."""

    if method:
        method_text = _lowercase_metric_outcome(method)
        article = "an" if re.match(r"[aeiou]", method_text, re.IGNORECASE) else "a"
        scope = f"In {article} {method_text}"
        if institution:
            scope += f" at {institution}"
        return f"{scope} involving {sample}" if sample else scope
    return f"Among {sample}" if sample else ""


def _metric_caveat_repeats_timing(caveat: str, timing: str) -> bool:
    """Avoid repeating a use-frequency qualifier already retained in the timing phrase."""

    return bool(
        re.search(r"\bdaily\s+use\b", caveat, re.IGNORECASE)
        and re.search(r"\bdaily\s+use\b", timing, re.IGNORECASE)
    )


def _render_korean_structured_metric(
    outcome: str,
    measurement: str,
    direction: str,
    timing: str,
    date_range: tuple[tuple[int, int, int], tuple[int, int, int]] | None,
    sample: str,
    method: str,
    institution: str,
    caveat: str,
) -> str:
    if timing and not re.search(r"(?:후|전|동안|직후|직전)$", timing):
        return ""
    if institution and not method:
        return ""
    scope: list[str] = []
    if date_range:
        scope.append(_korean_metric_period(date_range))
    if sample:
        scope.append(f"{sample}{_korean_metric_particle(sample, '을', '를')} 대상으로 한")
    if method:
        scope.append(f"{institution + ' ' if institution else ''}{method}에서")
    prefix = f"{timing}, " if timing else ""
    sentence = f"{prefix}{' '.join(scope)} {outcome}{_korean_metric_particle(outcome, '이', '가')} {measurement} {direction}.".strip()
    return _metric_sentence_with_caveat(sentence, caveat, "ko-KR")


_SIGNED_MEASURED_DIRECTION = {"+": "더 높게", "-": "더 낮게", "\u2212": "더 낮게"}
_ENGLISH_SIGNED_MEASURED_DIRECTION = {"+": "higher", "-": "lower", "\u2212": "lower"}


def _unsigned_measurement(measurement: str) -> str:
    """Drop the sign a direction word already states.

    A chart prints "+84.3%" and the sentence says the product was higher: the
    sign and the word say the same thing, and publishing both states the
    direction twice.  Nothing is added by dropping it -- the direction is still
    read from the sign the page printed.
    """

    return clean_text(measurement).lstrip("+-\u2212")


def _render_english_comparative_metric(
    subject: str, claim: Mapping[str, Any], measurement: str, source: str
) -> str:
    """Render a charted comparison in English, on the same terms as Korean.

    The locale that has the grammar publishes the comparison and the locale
    that does not drops it, which is how one market's chart became evidence
    and the other market's identical chart became nothing.  English states a
    comparison with a comparative predicate, so it states it here.
    """

    comparator = clean_text(claim.get("comparator")) or clean_text(claim.get("baseline"))
    metric = next(
        (clean_text(claim.get(field)) for field in ("metric", "label") if clean_text(claim.get(field))), ""
    )
    method = _english_metric_method_phrase(clean_text(claim.get("method")))
    timing = clean_text(claim.get("timing"))
    direction = _ENGLISH_SIGNED_MEASURED_DIRECTION.get(clean_text(claim.get("value"))[:1], "")
    if not subject or not comparator or not measurement or not metric or not direction:
        return ""
    if not method and not clean_text(claim.get("sample")):
        return ""
    for stated in (comparator, metric, clean_text(claim.get("method")), timing):
        if stated and not _metric_source_contains_text(source, stated):
            return ""
    locus = f"the {_lowercase_metric_outcome(metric)} of {_english_metric_article(method)} {method}" if method else f"the {_lowercase_metric_outcome(metric)}"
    when = f" {timing}" if timing else ""
    sentence = (
        f"In {locus}, {subject} measured {_unsigned_measurement(measurement)} "
        f"{direction} than {comparator}{when}."
    )
    caveat = clean_text(claim.get("caveat"))
    return _metric_sentence_with_caveat(
        sentence, caveat if caveat and _metric_source_contains_text(source, caveat) else "", "en-US"
    )


def _english_metric_article(value: str) -> str:
    return "an" if re.match(r"[aeiou]", clean_text(value), re.IGNORECASE) else "a"


def _render_korean_comparative_metric(
    subject: str, claim: Mapping[str, Any], measurement: str, source: str
) -> str:
    """Render a charted result against the series it was compared with.

    A chart states a comparison: two series, one figure per timepoint, and the
    sign the page printed in front of the figure says which way the comparison
    runs.  The delta renderer needs a direction word the page never wrote, so
    every charted result was dropped -- which cost a page the evidence its
    chart exists to give.

    The direction is read off the sign, not guessed: a page that printed "+"
    printed which series is the higher one.  Everything else is the page's --
    the analysis it names, the series it compared, the timepoint it labelled --
    and the comparison is published only when the page named the series, so a
    figure never reaches public copy as an absolute result of the product.
    """

    comparator = clean_text(claim.get("comparator")) or clean_text(claim.get("baseline"))
    metric = next(
        (clean_text(claim.get(field)) for field in ("metric", "label") if clean_text(claim.get(field))), ""
    )
    method = clean_text(claim.get("method"))
    timing = clean_text(claim.get("timing"))
    direction = _SIGNED_MEASURED_DIRECTION.get(clean_text(claim.get("value"))[:1], "")
    if not subject or not comparator or not measurement or not metric or not direction:
        return ""
    if not method and not clean_text(claim.get("sample")):
        return ""
    for stated in (comparator, metric, method, timing):
        if stated and not _metric_source_contains_text(source, stated):
            return ""
    locus = f"{method}의 {metric}" if method else metric
    when = f"{timing} " if timing else ""
    sentence = (
        f"{locus}에서, {subject}{_korean_metric_particle(subject, '은', '는')} "
        f"{comparator} 대비 {when}{_unsigned_measurement(measurement)} {direction} 나타났습니다."
    )
    return _metric_sentence_with_caveat(
        sentence, clean_text(claim.get("caveat")) if _metric_source_contains_text(source, clean_text(claim.get("caveat"))) else "", "ko-KR"
    )


_METRIC_STUDY_SCOPE_FIELDS = ("sample", "period", "method", "institution", "timing", "caveat", "comparator", "baseline")


def metric_claims_share_one_study(claims: Sequence[Mapping[str, Any]]) -> bool:
    """Return whether these claims are results of one and the same study."""

    if len(claims) < 2:
        return False
    scopes = {
        tuple(clean_text(as_dict(claim).get(field)) for field in _METRIC_STUDY_SCOPE_FIELDS) for claim in claims
    }
    return len(scopes) == 1 and any(scopes.pop())


_METRIC_TIMEPOINT_SCOPE_FIELDS = tuple(
    field for field in ("sample", "period", "method", "institution", "caveat", "comparator", "baseline")
)


def _render_korean_comparative_timepoints(subject: str, claims: Sequence[Mapping[str, Any]]) -> str:
    """State one charted comparison once and coordinate the timepoints it read.

    A chart reads the same comparison at several timepoints.  Published as one
    sentence per bar, the analysis, the series compared and the study are
    repeated for every bar, and the reader meets one comparison three times.
    The comparison is stated once and the readings follow it in the order the
    chart printed them, which is also the order that makes them a trend.
    """

    records = [as_dict(claim) for claim in claims]
    if len(records) < 2:
        return ""
    scopes = {
        tuple(clean_text(record.get(field)) for field in _METRIC_TIMEPOINT_SCOPE_FIELDS) for record in records
    }
    if len(scopes) != 1:
        return ""
    first = records[0]
    comparator = clean_text(first.get("comparator")) or clean_text(first.get("baseline"))
    metric = next((clean_text(first.get(field)) for field in ("metric", "label") if clean_text(first.get(field))), "")
    method = clean_text(first.get("method"))
    source = clean_text(first.get("sourceText")) or clean_text(first.get("sentence"))
    if not subject or not comparator or not metric or not source:
        return ""
    directions = {_SIGNED_MEASURED_DIRECTION.get(clean_text(record.get("value"))[:1], "") for record in records}
    if len(directions) != 1 or not (direction := directions.pop()):
        return ""
    readings: list[str] = []
    for record in records:
        timing = clean_text(record.get("timing"))
        measurement = _metric_measurement(clean_text(record.get("value")), clean_text(record.get("unit")))
        if not timing or not measurement or not _metric_source_contains_timing(source, timing):
            return ""
        readings.append(f"{timing} {_unsigned_measurement(measurement)}")
    if len({reading for reading in readings}) != len(readings):
        return ""
    for stated in (comparator, metric, method):
        if stated and not _metric_source_contains_text(source, stated):
            return ""
    locus = f"{method}의 {metric}" if method else metric
    sentence = (
        f"{locus}에서, {subject}{_korean_metric_particle(subject, '은', '는')} "
        f"{comparator} 대비 {', '.join(readings)} {direction} 나타났습니다."
    )
    caveat = clean_text(first.get("caveat"))
    return _metric_sentence_with_caveat(
        sentence, caveat if caveat and _metric_source_contains_text(source, caveat) else "", "ko-KR"
    )


def render_merged_measured_result_metric(
    claims: Sequence[Mapping[str, Any]], locale: str, *, subject: str = ""
) -> str:
    """State one study once and coordinate the results it reported.

    A study that measured two things reports two results under one population,
    one period and one disclaimer.  Published as two sentences, the reader is
    given that scope twice and the description spends two sentences saying one
    study ran -- the same waste a repeated subject makes, and more visible,
    because the repeated part is the longest clause in each sentence.

    The scope is stated once and the results are coordinated after it.  Every
    result still had to qualify on its own, so this changes how the qualified
    results are written, not which ones may be published.
    """

    if not locale.casefold().startswith("ko"):
        return ""
    timepoints = _render_korean_comparative_timepoints(subject, claims)
    if timepoints:
        return timepoints
    if not metric_claims_share_one_study(claims):
        return ""
    clauses: list[str] = []
    for claim in claims:
        data = as_dict(claim)
        measurement = _metric_measurement(clean_text(data.get("value")), clean_text(data.get("unit")))
        measured = clean_text(data.get("subject"))
        act = _measured_thing_beyond_subject(clean_text(data.get("label")), measured)
        if not measurement or not measured or not re.fullmatch(r"[가-힣]{1,6}", act):
            return ""
        clauses.append(f"{measured}{_korean_metric_particle(measured, '을', '를')} {measurement} {act}")
    # Every result but the last hands the sentence on; the last one closes it.
    joined = ", ".join([f"{clause}하며" for clause in clauses[:-1]] + [f"{clauses[-1]}했습니다"])
    first = as_dict(claims[0])
    rendered = render_structured_table_metric_sentence(first, locale, subject=subject)
    if not rendered:
        return ""
    single = _korean_measured_result_clause(subject, first, _metric_measurement(
        clean_text(first.get("value")), clean_text(first.get("unit"))
    ))
    if not single or single not in rendered:
        return ""
    return rendered.replace(single, f"{subject}{_korean_metric_particle(subject, '은', '는')} {joined}", 1)


def _korean_measured_result_clause(product: str, claim: Mapping[str, Any], measurement: str) -> str:
    """State a measured result as the product doing what the panel measured.

    A results panel writes one phrase whose middle is the number: what was
    measured, the figure, then the act measured -- "집앞 나갈때 가볍게 하는 색조
    메이크업 97.1% 세정".  Published as a noun phrase owned by the product, that
    reads as the product's makeup rather than as what the product removed, and
    the sentence says nothing.  The same three parts read as a clause instead:
    the product is the subject, what was measured is its object, and the act is
    its predicate.

    Every word is the panel's.  The act is conjugated only when the panel
    printed it as a bare act -- the position a measured panel prints its verb
    in -- so nothing is turned into a predicate that the page wrote as a name.
    """

    measured = clean_text(claim.get("subject"))
    act = _measured_thing_beyond_subject(clean_text(claim.get("label")), measured)
    if not product or not measured or not measurement:
        return ""
    if not re.fullmatch(r"[가-힣]{1,6}", act):
        return ""
    return (
        f"{product}{_korean_metric_particle(product, '은', '는')} "
        f"{measured}{_korean_metric_particle(measured, '을', '를')} "
        f"{measurement} {act}했습니다"
    )


def _render_korean_measured_result_metric(
    subject: str,
    result_clause: str,
    result_phrase: str,
    timing: str,
    date_range: tuple[tuple[int, int, int], tuple[int, int, int]] | None,
    sample: str,
    method: str,
    institution: str,
    caveat: str,
) -> str:
    """Render a measured result the source states as a phrase rather than a change.

    The delta renderer needs a direction word, and a share of something
    measured has none, so these results were dropped -- which cost a page its
    strongest evidence while an unqualified table row went out in its place.

    Nothing is composed here beyond the study scope the same row states.  The
    result keeps the source's own wording, and the scope is published only when
    the row names both who was measured and how, so a bare figure never reaches
    public copy without the population and method it was taken under.
    """

    if not result_phrase or not sample:
        return ""
    if timing and not re.search(r"(?:후|전|동안|직후|직전)$", timing):
        return ""
    # A fronted adverbial names when the result was read.  A before/after pair
    # names two readings instead -- that is the measurement's design, not a
    # moment -- and fronting it produces "사용 전/후, …결과가 제시되었습니다".
    if timing and re.search(r"전", timing) and re.search(r"후", timing):
        timing = ""
    scope: list[str] = []
    if date_range:
        scope.append(_korean_metric_period(date_range))
    # Who was measured, and when, is the scope a result needs.  A page that
    # names no method still bounds its result by its population and period, and
    # requiring a method it never printed dropped the page's own measurement.
    scope.append(f"{sample}{_korean_metric_particle(sample, '을', '를')} 대상으로{' 한' if method else ''}")
    if method:
        scope.append(f"{institution + ' ' if institution else ''}{method}에서")
    prefix = f"{timing}, " if timing else ""
    # An answer engine lifts one sentence, so the product the page measured is
    # named in it.  Where the panel's three parts read back as a clause, that
    # clause is the sentence; otherwise the page's own phrase is reported as
    # what the page presented, without an owner that would make it nonsense.
    if result_clause:
        sentence = f"{prefix}{' '.join(scope)}, {result_clause}.".strip()
    else:
        sentence = f"{prefix}{' '.join(scope)} {result_phrase} 결과가 제시되었습니다.".strip()
    return _metric_sentence_with_caveat(sentence, caveat, "ko-KR")


def _english_metric_period(date_range: tuple[tuple[int, int, int], tuple[int, int, int]]) -> str:
    start, end = date_range
    return f"from {_english_metric_date(start)} to {_english_metric_date(end)}"


def _english_metric_date(value: tuple[int, int, int]) -> str:
    year, month, day = value
    return f"{_ENGLISH_MONTH_NAMES[month - 1]} {day}, {year}"


def _korean_metric_period(date_range: tuple[tuple[int, int, int], tuple[int, int, int]]) -> str:
    start, end = date_range
    return f"{start[0]:04d}.{start[1]:02d}.{start[2]:02d}부터 {end[0]:04d}.{end[1]:02d}.{end[2]:02d}까지"


def _korean_metric_particle(value: str, consonant: str, vowel: str) -> str:
    last = value[-1:]
    if not last or not ("가" <= last <= "힣"):
        return consonant
    return consonant if (ord(last) - ord("가")) % 28 else vowel


def _capitalize_metric_outcome(value: str) -> str:
    return value[:1].upper() + value[1:]


def _lowercase_metric_outcome(value: str) -> str:
    return value[:1].lower() + value[1:] if value else value


def _metric_sentence(value: str) -> str:
    return value if re.search(r"[.!?。！？]$", value) else f"{value}."


def create_conservative_content_plan(request: Mapping[str, Any]) -> dict[str, Any]:
    """Make the fail-closed model-free plan used by the retained TS runtime.

    A conservative plan is intentionally *not* a second copy renderer.  It
    withholds Product/WebPage prose and FAQ membership until a model can cite
    it; the deterministic renderer owns those source-backed fallbacks.  Its
    only affirmative decision is whether already-normalized source usage can
    form an evidence-cited HowTo candidate.
    """

    product, locale = as_dict(request.get("product")), str(request.get("locale") or "en-US")
    ledger = [as_dict(item) for item in as_list(request.get("evidenceLedger"))]
    usage_evidence = [item for item in ledger if clean_text(item.get("role")) == "usage"]
    name = clean_text(product.get("name")) or "Untitled product"

    # The normalized ``usage`` field wins: semantic/source text can restore an
    # explicit sequence, but it must not invent a sequence from unrelated
    # notes.  Keep the raw source boundaries until the canonical-procedure
    # extractor has had a chance to join a full numbered routine with later
    # numbered fragments.
    direct_values = [
        clean_text(value)
        for value in as_list(product.get("usage"))
        if clean_text(value) and not _is_review_derived_usage_text(clean_text(value), product)
    ]
    direct = _unique_concrete_usage(direct_values)
    source_values = [
        clean_text(value)
        for value in as_list(product.get("sourceTexts"))
        if "usage" in _evidence_roles(clean_text(value))
        and not is_raw_page_text_block(clean_text(value))
        and not _is_review_derived_usage_text(clean_text(value), product)
    ]
    source_usage = _unique_concrete_usage(source_values)
    semantic = as_dict(product.get("semanticFacts"))
    semantic_values = [
        clean_text(value)
        for value in as_list(semantic.get("usageSteps"))
        if clean_text(value) and not _is_review_derived_usage_text(clean_text(value), product)
    ]
    semantic_usage = _unique_concrete_usage(semantic_values)
    explicit_direct = _explicit_usage_sequence(direct_values)
    explicit_source = _explicit_usage_sequence(source_values)
    explicit_semantic = _explicit_usage_sequence(semantic_values)
    if not explicit_direct:
        direct = _without_incomplete_numbered_usage(direct)
    if not explicit_source:
        source_usage = _without_incomplete_numbered_usage(source_usage)
    if not explicit_semantic:
        semantic_usage = _without_incomplete_numbered_usage(semantic_usage)
    semantic_ordered_direct = _semantic_usage_sequence_matches_direct(direct, semantic_usage)
    source_extends_direct = (
        len(direct) == 1
        and bool(explicit_source)
        and any(_usage_actions_match(direct[0], source_step) for source_step in explicit_source)
    )

    # A source that assigns ordinal positions is a procedure.  A collection of
    # otherwise independent actions is not; keep it as one canonical source
    # instruction rather than inventing positions from list order.
    source_order_is_explicit = False
    if explicit_direct:
        selected = explicit_direct
        source_order_is_explicit = True
    elif source_extends_direct:
        selected = explicit_source
        source_order_is_explicit = True
    elif semantic_ordered_direct:
        # ``semanticFacts.usageSteps`` is the normalized, source-linked usage
        # relation.  Its matching prefix corroborates the independently
        # extracted product procedure, but later semantic usage may be an
        # ancillary routine note rather than another source step.  Keep the
        # direct source boundaries so that note cannot extend the HowTo.
        selected = direct
        source_order_is_explicit = True
    elif len(direct) == 1:
        selected = direct
    elif explicit_source:
        selected = explicit_source
        source_order_is_explicit = True
    elif len(source_usage) == 1:
        selected = source_usage
    elif direct:
        selected = direct
    elif source_usage:
        selected = source_usage
    elif explicit_semantic:
        selected = explicit_semantic
        source_order_is_explicit = True
    else:
        selected = semantic_usage

    # Keep every independently extracted instruction as its own visible row.
    # ``ordered`` separately controls whether Schema.org HowTo is emitted, so
    # preserving a source boundary never invents a sequential procedure.
    step_sources = [(_canonical_usage_text(text), [text]) for text in selected]
    steps = [
        {
            "position": index + 1,
            # A text truncation is not an independently sourced step label.
            "name": "",
            "text": text,
            "evidenceIds": _unique_strings(
                [evidence_id for source_text in source_texts for evidence_id in _matching_evidence_ids(source_text, usage_evidence)]
            ),
        }
        for index, (text, source_texts) in enumerate(step_sources)
        if text
    ]
    eligible = bool(steps) and len(steps) == len(step_sources) and all(as_list(step.get("evidenceIds")) for step in steps)
    if not eligible:
        steps = []
    evidence_ids = _unique_strings(
        [evidence_id for step in steps for evidence_id in as_list(step.get("evidenceIds"))]
    )

    def empty_field(intent: str) -> dict[str, Any]:
        return {
            "include": False,
            "text": "",
            "intent": intent,
            "evidenceIds": [],
            "confidence": 0,
            "omitReason": "No model-backed field plan was available; the source-backed renderer fallback is used.",
        }

    relationship_cards = build_faq_relationship_cards(product, ledger, locale)
    return {
        "mode": "conservative",
        "locale": locale,
        "productDescription": empty_field("product-entity-summary"),
        "webPageDescription": empty_field("page-coverage-summary"),
        "faq": [],
        "faqRelationshipCards": relationship_cards,
        "howTo": {
            "eligible": eligible,
            "ordered": eligible and (source_order_is_explicit or len(selected) <= 1),
            "goal": _how_to_goal(name, locale) if eligible else "",
            "steps": steps,
            "evidenceIds": evidence_ids if eligible else [],
            "confidence": 0.75 if eligible else 0.85,
            "omitReason": "" if eligible else "The source does not contain a concrete source-backed customer usage action.",
        },
        "cep": [],
        "warnings": [],
    }


def _evidence_roles(value: str) -> set[str]:
    return {clean_text(item) for item in as_list(as_dict(infer_pdp_evidence_roles(value)).get("roles"))}


def _unique_concrete_usage(values: Iterable[object]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        text = clean_text(raw)
        key = re.sub(r"[^\w]+", " ", text.casefold()).strip()
        if text and key not in seen and is_concrete_usage_action(text):
            seen.add(key)
            result.append(text)
    return result


def _without_incomplete_numbered_usage(values: Iterable[str]) -> list[str]:
    """Keep a rejected ordinal from falling through as a new first HowTo row."""

    return [value for value in values if not has_explicit_numbered_usage_marker(value)]


def _is_review_derived_usage_text(value: str, product: Mapping[str, Any]) -> bool:
    text = clean_text(value)
    if not text:
        return False
    reviews = as_dict(product.get("reviews"))
    review_text = " ".join(
        clean_text(as_dict(item).get("body")) for item in as_list(reviews.get("items")) if clean_text(as_dict(item).get("body"))
    )
    return bool(review_text and text.casefold() in review_text.casefold())


def _explicit_usage_sequence(values: Sequence[str]) -> list[str]:
    """Recover one explicitly ordered source procedure without creating one.

    Source extractors can emit a complete ``1. … 2. …`` block alongside a
    later standalone ``3. …`` fragment.  Read every numbered fragment before
    deciding whether the ordinal sequence is complete, so the canonical plan
    retains the source's real positions and cardinality.  Conflicting text at
    the same ordinal means the source order is ambiguous and is not promoted
    into a procedure.
    """

    if source_steps := extract_explicit_numbered_usage_steps(values):
        return [_canonical_usage_text(step) for step in source_steps]

    numbered: list[tuple[int, str]] = []
    for value in values:
        numbered.extend(_numbered_usage_fragments(value))
    if numbered:
        by_position: dict[int, str] = {}
        for position, text in numbered:
            existing = by_position.get(position)
            if existing is None:
                by_position[position] = text
            elif not _usage_actions_match(existing, text):
                return []
        positions = sorted(by_position)
        if positions and positions == list(range(1, len(positions) + 1)):
            return [by_position[position] for position in positions]

    candidates = [_canonical_usage_text(value) for value in values]
    candidates = [value for value in candidates if is_concrete_usage_action(value)]
    if len(candidates) < 2:
        return []
    markers = [_lexical_usage_sequence_marker(value) for value in candidates]
    if markers[0] != "start" or any(marker not in {"continue", "end"} for marker in markers[1:]):
        return []
    if "end" in markers[:-1]:
        return []
    return candidates


_NUMBERED_USAGE_MARKER = re.compile(
    r"(?<!\S)(?:step\s*)?(\d+)\s*(?:단계|段階)?(?P<delimiter>[.):、:]?)\s+", re.IGNORECASE
)
_LEADING_USAGE_STEP_MARKER = re.compile(
    r"^\s*(?:(?:사용\s*방법|사용법|how\s*to\s*use|directions?|使用方法)\s*[.:：]?\s*)?"
    r"(?:step\s*)?\d+\s*(?:단계|段階)?(?:[.):、:]\s*|\s+)",
    re.IGNORECASE,
)
_USAGE_SENTENCE_END = re.compile(r"[.!?。！？](?=\s|$)")
_TRAILING_USAGE_LABEL = re.compile(
    r"[A-Z0-9][A-Z0-9&'’/.\-]*(?:\s+[A-Z0-9][A-Z0-9&'’/.\-]*){0,7}$"
)


def _numbered_usage_fragments(value: str) -> list[tuple[int, str]]:
    text = clean_text(value)
    matches = [
        marker
        for marker in _NUMBERED_USAGE_MARKER.finditer(text)
        if _is_explicit_numbered_usage_marker(text, marker)
    ]
    if not matches:
        return []
    fragments: list[tuple[int, str]] = []
    for index, marker in enumerate(matches):
        text_end = matches[index + 1].start() if index + 1 < len(matches) else None
        step_text = _close_usage_sentence(text[marker.end() : text_end])
        if not is_concrete_usage_action(step_text):
            return []
        fragments.append((int(marker.group(1)), step_text))
    return fragments


def _is_explicit_numbered_usage_marker(value: str, marker: re.Match[str]) -> bool:
    """Reject quantities such as ``layer 1 with`` while retaining OCR list rows."""

    if marker.group("delimiter"):
        return True
    prefix = value[: marker.start()].rstrip()
    return not prefix or bool(
        re.search(r"(?:[.!?。！？]|사용\s*방법|사용법|how\s*to\s*use|directions?|使用方法)$", prefix, re.IGNORECASE)
    )


def _close_usage_sentence(value: str) -> str:
    text = clean_text(value)
    sentence_ends = list(_USAGE_SENTENCE_END.finditer(text))
    if sentence_ends:
        last_sentence = sentence_ends[-1]
        trailing = text[last_sentence.end() :].strip()
        if len(trailing) <= 80 and _TRAILING_USAGE_LABEL.fullmatch(trailing):
            return clean_text(text[: last_sentence.end()])
    return text


def _canonical_usage_text(value: str) -> str:
    return clean_text(_LEADING_USAGE_STEP_MARKER.sub("", clean_text(value)))


def _usage_actions_match(left: str, right: str) -> bool:
    left_key = re.sub(r"[^\w]+", " ", _canonical_usage_text(left).casefold()).strip()
    right_key = re.sub(r"[^\w]+", " ", _canonical_usage_text(right).casefold()).strip()
    return bool(left_key and right_key and (left_key == right_key or left_key in right_key or right_key in left_key))


def _semantic_usage_sequence_matches_direct(direct: Sequence[str], semantic: Sequence[str]) -> bool:
    """Recognize an extractor-preserved source sequence without trusting list order alone.

    ``semanticFacts.usageSteps`` is a relationship produced from the source,
    rather than an arbitrary copy list.  We require every independently
    extracted direct action to match the semantic prefix in order before
    allowing it to establish a multi-step HowTo.  Later semantic items can be
    ancillary routine notes, so they cannot add source steps.  This prevents
    two incidental usage notes from becoming an invented procedure.
    """

    return bool(
        len(direct) >= 2
        and len(semantic) >= len(direct)
        and all(
            _usage_actions_match(source, normalized)
            for source, normalized in zip(direct, semantic[: len(direct)], strict=True)
        )
    )


def _lexical_usage_sequence_marker(value: str) -> str | None:
    text = _canonical_usage_text(value)
    if re.match(r"^(?:first(?:ly)?\b|(?:먼저|우선|まず)(?:\s|[,，、:]|$))", text, re.IGNORECASE):
        return "start"
    if re.match(r"^(?:finally\b|(?:마지막으로|最後に)(?:\s|[,，、:]|$))", text, re.IGNORECASE):
        return "end"
    if re.match(r"^(?:then\b|next\b|after(?:wards?)?\b|(?:그\s*다음|다음으로|이후|次に|その後)(?:\s|[,，、:]|$))", text, re.IGNORECASE):
        return "continue"
    return None


def _matching_evidence_ids(value: str, evidence: Sequence[Mapping[str, Any]]) -> list[str]:
    key = re.sub(r"[^\w]+", " ", clean_text(value).casefold()).strip()
    return [
        clean_text(item.get("id"))
        for item in evidence
        if clean_text(item.get("id"))
        and (
            key == re.sub(r"[^\w]+", " ", clean_text(item.get("text")).casefold()).strip()
            or key in re.sub(r"[^\w]+", " ", clean_text(item.get("text")).casefold()).strip()
            or re.sub(r"[^\w]+", " ", clean_text(item.get("text")).casefold()).strip() in key
        )
    ]


def _how_to_goal(name: str, locale: str) -> str:
    if locale == "ko-KR":
        return f"{name} 사용 방법"
    if locale == "ja-JP":
        return f"{name}の使い方"
    return f"How to use {name}"


async def plan_pdp_geo_content(request: Mapping[str, Any], options: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Apply an evidence-bound planner only after strict source admission.

    The resolver intentionally mirrors the retained TypeScript control plane:
    an explicit disable wins even over an injected planner, while an enabled
    real provider uses the shared native provider adapters rather than a
    special Python-only request path.
    """

    conservative = create_conservative_content_plan(request)
    supplied_cards = _trusted_faq_relationship_cards(request)
    planning_cards = supplied_cards or _trusted_faq_relationship_cards(conservative)
    # Relationship cards are internal orchestration context rather than
    # provider-owned public-plan fields.  Keep the exact scoped set on the
    # conservative path too, so an accepted model plan and its recovery pass
    # cannot silently expand back to the unscoped generated card collection.
    conservative["faqRelationshipCards"] = planning_cards
    planning_request = {
        **request,
        # Service callers may have already built a scoped, ranked card set.
        # Preserve that exact set across the initial and recovery calls rather
        # than expanding the membership candidates behind their back.
        "faqRelationshipCards": planning_cards,
    }
    runtime = as_dict(options)
    planner, resolution_warning = _resolve_content_planner(runtime)
    if planner is None:
        warnings = [resolution_warning] if resolution_warning else []
        if warnings:
            conservative["warnings"] = [*as_list(conservative.get("warnings")), *warnings]
        conservative["admissionDiagnostics"] = {
            "modelCall": {"called": False, "outcome": "notCalled"},
            "fields": [],
            "fallback": "deterministic-source-backed",
        }
        return {
            "plan": conservative,
            "evidence": ([{"field": "content.plan", "source": "llm", "value": f"Semantic planning skipped: {warnings[0]}"}] if warnings else []),
            "warnings": warnings,
            "called": False,
            "applied": False,
        }
    try:
        initial_data = await _run_content_planner(planner, planning_request)
        usage = initial_data.get("usage")
        planner_warnings = [str(item) for item in as_list(initial_data.get("warnings"))]
        model_backed_audit = isinstance(planner, ModelBackedContentPlanner)
        initial_candidate = as_dict(initial_data.get("plan"))
        initial_has_plan = bool(initial_candidate)
        plan, gate_warnings = _admit_model_plan(initial_candidate, planning_request) if initial_has_plan else (None, [])
        relationship_cards_in_request = [
            as_dict(card) for card in as_list(planning_request.get("faqRelationshipCards"))
        ]
        faq_model_recovery: dict[str, Any] = {"called": False, "outcome": "notNeeded", "requestedCardIds": []}
        retry_warnings: list[str] = []

        async def run_planner_pass(request: Mapping[str, Any]) -> tuple[dict[str, Any] | None, list[str], str]:
            """Run one corrective planner call and report its plan, gate warnings, and failure."""

            nonlocal usage
            try:
                data = await _run_content_planner(planner, dict(request))
            except Exception as error:  # noqa: BLE001 - reported to the caller as a warning
                return None, [], str(error) or "unknown error"
            usage = merge_token_usage(usage, data.get("usage"))
            planner_warnings.extend(str(item) for item in as_list(data.get("warnings")))
            candidate = as_dict(data.get("plan"))
            if not candidate:
                return None, [], ""
            retry_plan, retry_gate_warnings = _admit_model_plan(candidate, request)
            return retry_plan, retry_gate_warnings, ""

        # Correcting the singular fields and recovering FAQ membership fix two
        # different failures, and sharing one corrective slot made them compete:
        # a failed FAQ row took the pass that a rejected description needed, so
        # the description lost its only correction for a reason of its own.  The
        # correction pass is therefore decided without reference to FAQ, and FAQ
        # recovery runs afterwards as its own call.
        correction_reasons = (
            [reason for reason in gate_warnings if _planning_warning_field(reason) != "FAQ"]
            or (
                [
                    "Audit every candidatePlan clause for semantic entailment, claim modality, locale, and evidence-ID relevance; return a corrected full plan."
                ]
                if initial_has_plan and model_backed_audit
                else []
            )
            or (planner_warnings if planner_warnings else [])
            or (["The provider returned no parseable plan matching the required JSON schema."] if not initial_has_plan else [])
        )
        if correction_reasons:
            correction_request = dict(planning_request)
            if model_backed_audit and initial_has_plan:
                correction_request["candidatePlan"] = initial_candidate
            correction_request["planningFeedback"] = [
                {"field": _planning_warning_field(reason), "reason": reason} for reason in correction_reasons
            ]
            retry_plan, retry_gate_warnings, failure = await run_planner_pass(correction_request)
            if failure:
                retry_warnings.append(f"Corrective content-planning pass failed: {failure}")
            elif retry_plan is None and not retry_gate_warnings:
                retry_warnings.append("Corrective content-planning pass returned no valid plan.")
            elif retry_plan is not None and (
                plan is None
                or len(retry_gate_warnings) < len(gate_warnings)
                or (model_backed_audit and initial_has_plan and len(retry_gate_warnings) == len(gate_warnings))
            ):
                plan, gate_warnings = retry_plan, retry_gate_warnings
            else:
                retry_warnings.extend(retry_gate_warnings)
                if plan is not None:
                    retry_warnings.append(
                        "Corrective content-planning pass did not reduce evidence or locale gate failures; the safer first-pass plan was kept."
                    )

        # A relationship card is only semantic evidence until the model turns it
        # into customer-facing copy.  When FAQ rows are still missing, spend one
        # focused pass on those cards rather than asking Python to recreate FAQ
        # prose or reusing raw source headings.  Only FAQ rows are merged back,
        # so this pass cannot reach the descriptions, HowTo, or CEP.
        # With no admitted plan there is nothing to add FAQ rows to, and a
        # recovery response would become the plan itself -- descriptions
        # included.  FAQ recovery only ever supplements an existing plan.
        recovery_card_ids = _faq_recovery_card_ids(plan, relationship_cards_in_request) if plan is not None else []
        if recovery_card_ids:
            faq_model_recovery = {"called": True, "outcome": "pending", "requestedCardIds": recovery_card_ids}
            requested_card_ids = set(recovery_card_ids)
            recovery_request = dict(planning_request)
            recovery_request["faqRecoveryOnly"] = True
            recovery_request["faqRecoveryCardIds"] = recovery_card_ids
            recovery_request["faqRelationshipCards"] = [
                card for card in relationship_cards_in_request if clean_text(card.get("id")) in requested_card_ids
            ]
            recovery_request["planningFeedback"] = [
                {
                    "field": "FAQ",
                    "reason": "Compose only the missing FAQ relationship cards as natural customer-decision Q&A. "
                    "Use the supplied card IDs and evidence only; do not reuse raw source FAQ headings.",
                }
            ]
            recovered_plan, recovered_gate_warnings, failure = await run_planner_pass(recovery_request)
            if failure:
                faq_model_recovery["outcome"] = "unavailable"
                retry_warnings.append(f"FAQ recovery content-planning pass failed: {failure}")
            elif recovered_plan is not None and as_list(recovered_plan.get("faq")):
                plan = _merge_faq_model_recovery(plan, recovered_plan)
                faq_model_recovery["outcome"] = "admitted"
            elif recovered_plan is None and not recovered_gate_warnings:
                faq_model_recovery["outcome"] = "unavailable"
                retry_warnings.append("FAQ recovery content-planning pass returned no valid plan.")
            else:
                faq_model_recovery["outcome"] = "rejected"
                retry_warnings.extend(recovered_gate_warnings)

        if plan is None:
            warnings = _unique_strings(
                [
                    *planner_warnings,
                    *gate_warnings,
                    *retry_warnings,
                    "Semantic planner returned no valid content plan after one corrective pass; conservative applicability was used.",
                ]
            )
            conservative["warnings"] = [*as_list(conservative.get("warnings")), *warnings]
            conservative["admissionDiagnostics"] = {
                "modelCall": {"called": True, "outcome": "rejected"},
                "fields": [],
                "fallback": "deterministic-source-backed",
            }
            return {
                "plan": conservative,
                "evidence": [{"field": "content.plan", "source": "llm", "value": " ".join(warnings)}],
                "warnings": warnings,
                "called": True,
                "applied": False,
                **({"usage": usage} if usage is not None else {}),
            }

        admission_diagnostics = dict(as_dict(plan.get("admissionDiagnostics")))
        admission_diagnostics["modelCall"] = {"called": True, "outcome": "admitted"}
        admission_diagnostics["faqModelRecovery"] = faq_model_recovery
        accepted = {
            **conservative,
            **plan,
            "mode": "model",
            "admissionDiagnostics": admission_diagnostics,
            "warnings": _unique_strings(
                [*planner_warnings, *as_list(plan.get("warnings")), *retry_warnings]
            ),
        }
        return {
            "plan": accepted,
            "evidence": [
                {
                    "field": "content.plan",
                    "source": "llm",
                    "value": (
                        f"Evidence-bound content plan accepted with {len(as_list(accepted.get('faq')))} FAQ item(s), "
                        f"{len(as_list(as_dict(accepted.get('howTo')).get('steps'))) if as_dict(accepted.get('howTo')).get('eligible') else 0} "
                        f"HowTo step(s), and {len(as_list(accepted.get('cep')))} CEP candidate(s)."
                    ),
                }
            ],
            "warnings": accepted["warnings"],
            "called": True,
            "applied": True,
            **({"usage": usage} if usage is not None else {}),
        }
    except Exception as error:  # intended degraded-mode contract
        warning = f"DEGRADED_MODE: Semantic content planning was unavailable ({error}); the conservative source-backed renderer produced public copy without an evidence-bound plan."
        conservative["warnings"] = [*as_list(conservative.get("warnings")), warning]
        conservative["admissionDiagnostics"] = {
            "modelCall": {"called": True, "outcome": "unavailable"},
            "fields": [],
            "fallback": "deterministic-source-backed",
        }
        return {
            "plan": conservative,
            "evidence": [{"field": "content.plan", "source": "llm", "value": warning}],
            "warnings": [warning],
            "called": True,
            "applied": False,
        }


def _faq_recovery_card_ids(
    plan: Mapping[str, Any] | None, relationship_cards: Sequence[Mapping[str, Any]]
) -> list[str]:
    """Choose bounded, unadmitted card IDs for one model-only FAQ retry.

    Cards are ranked evidence inputs, not a deterministic public-copy
    fallback.  The planner receives at most the remaining membership capacity
    while it still has fewer than two customer-decision answers.
    """

    if plan is None:
        # A wire-invalid or absent first plan has no trustworthy row-level
        # result to recover. Ask the model for a normal corrected full plan
        # rather than mislabeling that repair as FAQ-only recovery.
        return []
    admitted = {
        clean_text(row.get("id"))
        for raw_row in as_list(as_dict(plan).get("faq"))
        if (row := as_dict(raw_row)) and row.get("include") is True and clean_text(row.get("id"))
    }
    if len(admitted) >= 2:
        return []
    capacity = max(0, 3 - len(admitted))
    return [
        identifier
        for raw_card in relationship_cards
        if (card := as_dict(raw_card))
        and (identifier := clean_text(card.get("id")))
        and identifier not in admitted
    ][:capacity]


def _merge_faq_model_recovery(
    initial: Mapping[str, Any] | None, recovered: Mapping[str, Any]
) -> dict[str, Any]:
    """Keep admitted first-pass fields while adding only recovered FAQ rows.

    The recovery call is scoped to FAQ membership.  Its descriptions, CEP, and
    HowTo candidates therefore cannot replace a separately admitted first-pass
    field.  Row diagnostics retain both phases so a rejected first attempt is
    observable even when its later, evidence-bound rewrite succeeds.
    """

    if initial is None:
        return dict(recovered)

    def included_rows(value: object) -> list[dict[str, Any]]:
        return [
            dict(row)
            for raw_row in as_list(value)
            if (row := as_dict(raw_row)) and row.get("include") is True and clean_text(row.get("id"))
        ]

    merged_faq = included_rows(initial.get("faq"))
    admitted_ids = {clean_text(row.get("id")) for row in merged_faq}
    for row in included_rows(recovered.get("faq")):
        identifier = clean_text(row.get("id"))
        if identifier not in admitted_ids and len(merged_faq) < 3:
            merged_faq.append(row)
            admitted_ids.add(identifier)

    initial_diagnostics = as_dict(initial.get("admissionDiagnostics"))
    recovered_diagnostics = as_dict(recovered.get("admissionDiagnostics"))
    initial_fields = [as_dict(item) for item in as_list(initial_diagnostics.get("fields")) if as_dict(item)]
    recovered_fields = [as_dict(item) for item in as_list(recovered_diagnostics.get("fields")) if as_dict(item)]
    # The rejected rows of both phases are kept for the same reason the fields
    # are: spreading the first pass alone would drop exactly the recovery-pass
    # sentences that a live rejection has to be read back from.
    rejected_rows = [
        as_dict(item)
        for diagnostics in (initial_diagnostics, recovered_diagnostics)
        for item in as_list(diagnostics.get("faqRejectedRows"))
        if as_dict(item)
    ]
    return {
        **initial,
        "faq": merged_faq,
        "admissionDiagnostics": {
            **initial_diagnostics,
            "fields": [*initial_fields, *recovered_fields],
            "faqInitialFields": initial_fields,
            "faqRecoveryFields": recovered_fields,
            **({"faqRejectedRows": rejected_rows} if rejected_rows else {}),
        },
        "warnings": _unique_strings(
            [*as_list(initial.get("warnings")), *as_list(recovered.get("warnings"))]
        ),
    }


def _resolve_content_planner(runtime: Mapping[str, Any]) -> tuple[object | None, str | None]:
    settings = as_dict(runtime.get("contentPlanning"))
    if settings.get("enabled") is False:
        return None, None
    custom = runtime.get("customContentPlanner") or runtime.get("contentPlanner")
    if custom is not None:
        return custom, None
    provider = clean_text(settings.get("provider")) or clean_text(runtime.get("provider")) or "mock"
    inherits_parent = not clean_text(settings.get("provider")) or provider == clean_text(runtime.get("provider"))
    api_key = settings.get("apiKey") if settings.get("apiKey") is not None else (runtime.get("apiKey") if inherits_parent else None)
    enabled = settings.get("enabled")
    if enabled is None:
        enabled = provider not in {"mock", "custom"} and bool(api_key)
    if enabled is not True:
        return None, None
    if provider in {"mock", "custom"}:
        return None, f"{provider} content planning requires customContentPlanner."
    stage_deployment = settings.get("deployment")
    if stage_deployment is None and inherits_parent:
        runtime_deployments = as_dict(runtime.get("deployments"))
        stage_deployment = runtime_deployments.get("reasoning")
        if stage_deployment is None:
            stage_deployment = runtime.get("deployment")
    config: dict[str, Any] = {
        "provider": provider,
        "apiKey": api_key,
        "model": settings.get("model") if settings.get("model") is not None else (runtime.get("model") if inherits_parent else None),
        "endpoint": settings.get("endpoint") if settings.get("endpoint") is not None else (runtime.get("endpoint") if inherits_parent else None),
        "deployment": stage_deployment,
        "apiVersion": settings.get("apiVersion") if settings.get("apiVersion") is not None else (runtime.get("apiVersion") if inherits_parent else None),
        "temperature": runtime.get("temperature"),
        "transport": settings.get("transport") if settings.get("transport") is not None else runtime.get("transport"),
        "timeoutSeconds": settings.get("timeoutSeconds") if settings.get("timeoutSeconds") is not None else runtime.get("timeoutSeconds"),
        "maxEvidenceItems": settings.get("maxEvidenceItems") if settings.get("maxEvidenceItems") is not None else _DEFAULT_MAX_EVIDENCE_ITEMS,
        "maxRagChunks": settings.get("maxRagChunks") if settings.get("maxRagChunks") is not None else _DEFAULT_MAX_RAG_CHUNKS,
    }
    return ModelBackedContentPlanner(config), None


@runtime_checkable
class _ContentPlanner(Protocol):
    def plan_content(self, request: Mapping[str, Any]) -> object: ...


def _call_content_planner(planner: object, request: Mapping[str, Any]) -> object:
    """Narrow the injectable JS-shaped planner boundary without weakening it."""

    if isinstance(planner, _ContentPlanner):
        return planner.plan_content(request)
    if callable(planner):
        return cast(Callable[[Mapping[str, Any]], object], planner)(request)
    raise TypeError("content planner must be callable or expose plan_content(request)")


async def _run_content_planner(planner: object, request: Mapping[str, Any]) -> dict[str, Any]:
    """Resolve an injected planner once while retaining its public mapping."""

    candidate = _call_content_planner(planner, request)
    if inspect.isawaitable(candidate):
        candidate = await candidate
    return as_dict(candidate)


def _planning_warning_field(reason: object) -> str:
    match = re.match(r"^(Product\.description|WebPage\.description|FAQ|HowTo)", clean_text(reason), re.IGNORECASE)
    return match.group(1) if match is not None else "content-plan"


_ADMISSION_LOCALES = frozenset({"ko-KR", "ja-JP", "en-US", "en-GB"})
_ADMISSION_SENTENCE_SPLIT = re.compile(r"(?<=[.!?。！？])\s+|\n+")
_ADMISSION_NUMBER = re.compile(
    r"(?:[$€£₩]\s*)?[+\-−]?\d+(?:[.,]\d+)?\s*(?:%|％|배|x|회|명|인|주|일|시간|분|초|"
    r"weeks?|days?|hours?|minutes?|seconds?|users?|participants?|subjects?|women|men|ml|mL|l|g|mg|µg|μg|kg|oz|ppm|mm|cm|°c)?",
    re.IGNORECASE,
)
_ADMISSION_TIMING = re.compile(
    r"\b(?:after|before|within|for)\s+\d+(?:[.,]\d+)?\s*(?:weeks?|days?|hours?|minutes?|seconds?)\b|"
    r"\d+(?:[.,]\d+)?\s*(?:주|일|시간|분)\s*(?:후|전|동안)",
    re.IGNORECASE,
)
_ADMISSION_METHOD = re.compile(
    r"\b(?:instrumental|clinical|study|testing|tested|assessment|measurement|panel|participants?)\b|"
    r"(?:임상|기기|측정|시험|테스트|평가|패널)",
    re.IGNORECASE,
)
_ADMISSION_CAVEAT = re.compile(
    r"\b(?:individual\s+results?\s+may\s+vary|results?\s+may\s+vary)\b|(?:개인\s*차|결과는\s*다를)"
    r"|(?:個人差|結果には差)",
    re.IGNORECASE,
)
_ADMISSION_COMPARISON = re.compile(r"\b(?:versus|vs\.?|compared\s+(?:with|to)|baseline)\b|(?:대비|비교)", re.IGNORECASE)
_ADMISSION_CONTEXTS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\b(?:pregnan\w*|expectant\w*)\b|(?:임신|임부)|(?:妊娠)", re.IGNORECASE),
    re.compile(r"\b(?:infants?|newborns?|toddlers?|children)\b|(?:영아|신생아|유아|어린이)|(?:乳児|新生児|幼児)", re.IGNORECASE),
    re.compile(r"\b(?:winter|summer|seasonal|travel|gift)\b|(?:겨울|여름|계절|여행|선물)|(?:冬|夏|季節|旅行|ギフト)", re.IGNORECASE),
)
_ADMISSION_CAUSAL = re.compile(
    r"\b(?:causes?|because|therefore|through|via|due\s+to|powered\s+by|based\s+on)\b|"
    r"(?:때문|통해|기반|덕분|유발)|(?:によって|を通じ|のため)",
    re.IGNORECASE,
)
_ADMISSION_REVIEW_ATTRIBUTION = re.compile(
    r"\b(?:reviews?|reviewers?|customers?|customer\s+feedback|users?)\b|(?:리뷰|후기|고객|사용자)|(?:レビュー|口コミ|利用者)",
    re.IGNORECASE,
)
_ADMISSION_REVIEW_CLAIM = re.compile(
    r"\b(?:reviews?|reviewers?|customer\s+feedback)\b|"
    r"\b(?:customers?|users?)\s+(?:mention|say|report|describe|note|feel)\b|"
    r"(?:고객\s*)?(?:리뷰|후기)|(?:고객|사용자)(?:는|들이)?\s*(?:언급|말하|평가)|"
    r"(?:レビュー|口コミ)|(?:利用者|ユーザー)(?:は|が)?\s*(?:言及|述べ)",
    re.IGNORECASE,
)
_ADMISSION_SENSITIVE_ASSERTION = re.compile(
    r"\b(?:safe\w*|suitab\w*|appropriate|recommend\w*|advis\w*|best|better|top[- ]?rated|can\s+(?:i|we|you)\s+use|may\s+(?:i|we|you))\b|"
    r"(?:안전|적합|권장|추천|사용해도|사용할\s*수)|(?:安全|適し|推奨|おすすめ|使え)",
    re.IGNORECASE,
)
_ADMISSION_ASSERTIVE_QUESTION = re.compile(
    r"^\s*(?:is|are|does|do|can|will|should|has|have)\b|(?:인가요|있나요|되나요|할\s*수\s*있나요)\s*[?？]?$|(?:ですか|ますか|できますか)\s*[?？]?$",
    re.IGNORECASE,
)
_ADMISSION_FAQ_ANALYST_OR_SOURCE_QUESTION = re.compile(
    r"\b(?:what|which)\s+(?:evidence|proof|basis|rationale|grounds?)\b|"
    r"\b(?:what|which).{0,120}\b(?:ingredients?|formula|components?|technology|evidence|proof|"
    r"study|test|results?|metrics?|measurement|usage|directions?)\b|"
    r"\b(?:what|which).{0,120}\b(?:contains?|includes?|features?|lists?)\b|"
    r"\b(?:how|what).{0,120}\b(?:interpret|evaluate|assess|analy[sz]e|understand)\b|"
    r"\bhow\s+(?:should|do|can).{0,120}\b(?:use|apply)\b|"
    r"\b(?:how\s+to\s+use|directions?|usage|application\s+steps?)\b|"
    r"\b(?:what|how)\s+(?:does|do|did).{0,120}\b(?:say|state|list|mention|describe|show|provide)\b|"
    r"\b(?:page|source|PDP)\b.{0,120}\b(?:say|state|list|mention|describe|show|provide)\b|"
    r"\b(?:what|how).{0,120}\b(?:product|brand)\b.{0,120}\b(?:say|state|list|mention|describe|show|provide)\b|"
    r"(?:근거|증거|이유).{0,32}(?:고려|해석|이해|판단|평가)|"
    r"(?:어떤|무엇).{0,48}(?:성분|처방|구성|근거|증거|시험|측정|결과|사용법|사용\s*순서|함유|포함)|"
    r"(?:어떻게|언제).{0,32}(?:사용|바르|적용)|(?:사용법|사용\s*방법|사용\s*순서)|"
    r"(?:어떻게|어떤).{0,40}(?:해석|이해|평가|판단)|"
    r"(?:페이지|원문|출처|상품정보).{0,56}(?:말하|설명|기재|안내|언급|보여|제시)|"
    r"(?:根拠|証拠).{0,24}(?:考え|解釈|理解|判断|評価)|(?:使い方|使用方法|手順)|"
    r"(?:どのように|どう).{0,24}(?:解釈|理解|評価|判断)|(?:ページ|原文|情報源).{0,40}(?:述べ|説明|記載|案内|示)",
    re.IGNORECASE,
)
_ADMISSION_FAQ_GENERIC_CATEGORY = re.compile(
    r"\b(?:product|serum|cream|moisturi[sz]er|lotion|essence|ampoule|skincare|skin\s+care|"
    r"treatment|care|routine)\b|(?:제품|세럼|크림|로션|에센스|앰플|스킨케어|케어|루틴)|"
    r"(?:製品|セラム|クリーム|ローション|エッセンス|アンプル|スキンケア|ケア|ルーティン)",
    re.IGNORECASE,
)
# What makes a sentence a recommendation is that it offers the product as one
# of the reader's options.  The noun that does so is closed -- a choice, an
# option, a pick, a fit -- but the adjective in front of it is the writer's, so
# enumerating that slot ("a *good* choice") rejects every other natural way of
# saying the same thing ("a *fitting* choice").
_ADMISSION_FAQ_RECOMMENDATION = re.compile(
    r"\b(?:recommend(?:ed|ation)?|worth\s+considering|consider(?:ed|ing)?|"
    r"works?\s+best\s+for|"
    r"(?:an?|the)\s+(?:[\w-]+\s+){0,2}(?:option|choice|pick|fit))\b|"
    # 한국어도 같다. 제품을 선택지로 내놓는 동사(고려·선택·추천·권장)는 닫힌
    # 집합이지만, 그 뒤의 가능 표현은 글쓴이의 것이다. ``고려할 수``만 적어 두면
    # ``선택할 수 있습니다``라는 똑같은 말이 추천으로 읽히지 않는다.
    r"(?:(?:고려|선택|추천|권장)(?:할|하실|해\s*볼)\s*(?:수|만)?|추천|좋은\s*선택|적합한?\s*(?:선택|제품))|"
    r"(?:おすすめ|検討(?:でき|する)|適した?(?:選択|製品))",
    re.IGNORECASE,
)
# What a recommendation may never add: a safety conclusion the source never
# drew, and a ranking against products the source never compared.  Neither
# depends on the card, so both are read here.  ``the best serum`` used to pass
# this list while a licensed fit was rejected by it.
_ADMISSION_BUYER_RECOMMENDATION_ESCALATION = re.compile(
    r"\b(?:safe\w*|better|right\s+(?:option|choice)|top[- ]?rated)\b|"
    r"\b(?:the|a|an)\s+(?:most\s+\w+|best)\b|"
    r"(?:안전|최고|최상|가장\s*좋)|(?:安全|最適|最高)",
    re.IGNORECASE,
)
# A fit verdict is different: whether it escalates depends on the card.  A card
# may license a recommendation from a purpose relation alone (``a solution for
# dryness``) -- the source says what the product is meant to answer without
# saying whom it suits -- and calling the product suitable on that card draws a
# conclusion the source never drew.  On a card whose own evidence states
# fitness, the same words restate the source.
_ADMISSION_BUYER_FIT_VERDICT = re.compile(r"\b(?:suitab\w*|appropriate)\b|(?:적합)|(?:適し)", re.IGNORECASE)
_ADMISSION_FAQ_SOURCE_NARRATION = re.compile(
    r"\b(?:the\s+)?(?:page|source|PDP)\s+(?:says?|states?|lists?|mentions?|describes?|shows?|provides?)\b|"
    # The same narrowing the Korean clause below already carries.  A bare
    # passive is not narration -- ``Radiance is listed as a benefit of X`` has
    # the fact as its subject, and extraction writes that frame into the source
    # itself, so an answer restating the fact inherits it.  Narration is the
    # record standing in the sentence: as the subject, which the clause above
    # reads, or as the place the fact was written down.  Reading the passive
    # alone made an English answer's publication turn on which reporting verb
    # the model happened to pick, while the Korean clause had already been
    # narrowed for exactly that reason.
    r"\b(?:is|are|was|were)\s+(?:presented|introduced|stated|shown|provided|listed)\b"
    r"(?=[^.!?]*\b(?:on|in|by|per)\s+(?:the\s+)?(?:page|source|PDP|listing|record|site)\b)|"
    r"\b(?:a|the)\s+(?:result|study|test|evidence)\s+(?:is|was|were)\s+(?:presented|stated|shown|provided)\b|"
    r"(?:페이지|원문|출처|상품정보).{0,48}(?:말하|설명|기재|안내|언급|보여|제시)|"
    # Narration is the source standing in the subject: ``원문은 … 안내합니다``.
    # A bare passive is not -- ``피부 장벽을 개선하는 성분으로 안내됩니다`` has the
    # ingredient as its subject, and extraction writes that frame into the source
    # itself, so the answer restating the fact inherits it.  Reading the passive
    # alone as narration made publication turn on which reporting verb the model
    # happened to pick (``설명됩니다`` passed, ``안내됩니다`` did not) while the
    # claim-frame set already treats both as frame rather than fact.
    r"(?:페이지|원문|출처|상품정보|자료|정보)(?:에|에서|가|는|은)?\s*(?:제시|안내|기재|표시|제공)(?:됩니다|되었|되어)|"
    r"(?:ページ|原文|情報源).{0,40}(?:述べ|説明|記載|案内|示)|(?:提示|記載|案内|提供)(?:され|です)",
    re.IGNORECASE,
)
_ADMISSION_STIFF_PAGE_WRAPPER = re.compile(
    r"\b(?:this\s+(?:product\s+)?page\s+(?:is|explains|covers|shows|lists)|complete\s+shopping\s+destination)\b|"
    r"(?:이\s*페이지에서는|페이지\s*본문에서는|페이지에서\s*확인할\s*수\s*있는|상품\s*페이지는)|"
    r"(?:このページでは|商品ページ)",
    re.IGNORECASE,
)
_ADMISSION_PAGE_REFERENCE = re.compile(
    r"\b(?:product(?:-detail)?\s+page|page|PDP)\b|(?:상품\s*페이지|제품\s*페이지)|(?:商品ページ)",
    re.IGNORECASE,
)
_ADMISSION_KOREAN_NATURAL_PAGE_OVERVIEW = re.compile(
    r"^(?P<subject>.+?)\s*(?:상품|제품)\s*페이지는\s+"
    r"(?:(?:제품의\s*)?(?:특징|내용)\s*(?:과|와)\s*)?"
    r"(?P<coverage>.+?)(?:을|를)?\s*"
    r"(?:(?:바탕으로\s*)?(?:제품의\s*)?(?:특징|내용)을\s*(?:소개|다루|설명)합니다|(?:함께\s*)?다룹니다)"
    r"(?:[.!?。！？])?$"
)
_ADMISSION_KOREAN_PAGE_OVERVIEW_LABELS = frozenset(
    {"대상 고객", "성분·포뮬러", "효능·효과", "사용법", "근거 지표", "고객 평가"}
)
_ADMISSION_COPY_ARTIFACT = re.compile(r"[☑※□■]|(?:^|\s)(?:Q|A)\s*[:：]", re.IGNORECASE)
_ADMISSION_COMPRESSED_METRICS = re.compile(
    r"\d+(?:\.\d+)?\s*[%％]\s*[+\-−±*＊※·•]?\s*\d+(?:\.\d+)?\s*[%％]\s*[+\-−±*＊※·•]?\s*\d+(?:\.\d+)?\s*[%％]"
)
_ADMISSION_TOPIC_PATTERNS: tuple[tuple[str, re.Pattern[str], frozenset[str]], ...] = (
    ("formula", re.compile(r"\b(?:ingredient|ingredients|formula|component|components|technology)\b|(?:성분|구성)|(?:成分|処方)", re.IGNORECASE), frozenset({"ingredient", "formula", "description", "source", "faq"})),
    ("benefit", re.compile(r"\b(?:benefit|benefits|effect|effects|hydration|sooth\w*)\b|(?:효능|효과|보습|수분|진정)|(?:効果|保湿)", re.IGNORECASE), frozenset({"benefit", "effect", "description", "metric", "source", "faq"})),
    ("usage", re.compile(r"\b(?:how\s+(?:should|do)|use|apply|routine|direction)\b|(?:사용|바르|루틴)|(?:使|塗|手順)", re.IGNORECASE), frozenset({"usage", "source", "faq"})),
    ("metric", re.compile(r"\b(?:metric|result|results|measured|measurement|test|testing|study)\b|(?:수치|결과|측정|시험)|(?:結果|測定|試験)", re.IGNORECASE), frozenset({"metric", "source", "faq"})),
    ("review", re.compile(r"\b(?:review|reviews|feedback|finish|texture)\b|(?:리뷰|후기|사용감)|(?:レビュー|口コミ|使用感)", re.IGNORECASE), frozenset({"review", "source", "faq"})),
    ("audience", re.compile(r"\b(?:audience|customer|customers|concern|skin\s+type|dry\s+skin)\b|(?:피부|고객|대상|건조)|(?:肌|対象|乾燥)", re.IGNORECASE), frozenset({"audience", "concern", "description", "source", "faq"})),
    ("commerce", re.compile(r"\b(?:price|cost|size|option|variant)\b|(?:가격|용량|옵션|버전)|(?:価格|容量|オプション|種類)", re.IGNORECASE), frozenset({"commerce", "faq", "source"})),
)

_ADMISSION_ENGLISH_BUYER_QUESTION = re.compile(
    r"\bwho\s+(?:is|are|was|were)\b.*\bfor\b|"
    r"\b(?:which|what)\s+(?:skin\s+types?|customers?|people|audience)\b|"
    r"\b(?:what|which).{0,96}\b(?:offer|help|suitable|best)\s+for\b",
    re.IGNORECASE,
)
_ADMISSION_KOREAN_BUYER_QUESTION = re.compile(
    r"(?:누구|어떤\s*(?:고객|피부)|피부\s*타입|대상(?:은|이|에게|으로)|"
    r"(?:피부|고객).{0,32}(?:위한|적합|좋|추천)|고민.{0,32}(?:위한|적합|좋|추천))"
)
_ADMISSION_ENGLISH_BUYER_ANSWER = re.compile(
    r"\b(?:works?\s+best|intended|suitable|designed|formulated|developed|created|made)\s+for\s*:?\s*"
    r"(?:[^.!?]{0,80}\b(?:skin(?:\s+types?)?|customers?|people|those)\b)|"
    r"\b(?:is|are|was|were)\s+for\b(?=[^.!?]{0,100}\b(?:skin(?:\s+types?)?|customers?|people|those)\b)|"
    r"^\s*(?:for|if)\s+[^.!?]{0,96}\b(?:skin(?:\s+types?)?|customers?|people|those)\b|"
    r"\b(?:a\s+)?solution\s+for\b|"
    r"\b(?:addresses?|targets?)\s+(?:fine\s+lines?|wrinkles?|loss\s+of\s+firmness|dryness)\b",
    re.IGNORECASE,
)
_ADMISSION_KOREAN_BUYER_ANSWER = re.compile(
    r"(?:피부|고객|사용자|건조|민감|노화).{0,42}(?:위한|대상(?:으로)?|적합(?:한)?|특화(?:된)?|맞춤(?:형)?|라면)"
)
_ADMISSION_TOKEN_WORD = re.compile(r"[A-Za-z0-9가-힣ぁ-んァ-ン一-龯]+")


def _admission_english_stem(token: str) -> str:
    """Reduce an English word to the stem its inflected forms share.

    A source states a claim in the base form (``helps improve the skin
    barrier``) and an answer conjugates it (``improves the skin barrier``), so
    a reader that counts those as two words can never find the answer's word in
    its source.  Removing the inflection is not enough by itself: an English
    base form keeps the silent ``-e`` that every inflected form drops, which
    left ``improve`` beside ``improv`` and ``reduce`` beside ``reduc``, and the
    subset this comparison tests was then impossible to satisfy in English at
    all.  The silent ``-e`` therefore goes too.

    A stem has to be long enough to be a stem, and that floor is what a short
    base and its own inflections were falling on opposite sides of: ``use``
    kept its ``-e`` because dropping it left two letters, while ``using`` and
    ``used`` could not drop their suffix for the same reason, so one word was
    counted as three.  A vowel-initial suffix is what replaced that silent
    ``-e``, so removing the suffix restores it, and the base and every
    inflection of it meet on the one form again.

    Reduction runs to a fixed point, which is what makes it idempotent --
    ``f(f(w)) == f(w)`` for every word -- so a word registered once compares
    equal to the same word read back out of prose.  Only inflection is removed:
    a derivational ending (``-ion``, ``-ness``, ``-er``) is part of what tells
    two words apart and stays, and a plural ``-s`` is not cut from a word that
    ends in ``-ss``.
    """

    while True:
        if len(token) > 5 and token.endswith("ies"):
            stem = f"{token[:-3]}y"
        elif len(token) > 4 and token.endswith("ing"):
            stem = _admission_english_suffix_stem(token[:-3])
        elif len(token) > 3 and token.endswith("ed"):
            stem = _admission_english_suffix_stem(token[:-2])
        elif len(token) > 3 and token.endswith("s") and not token.endswith("ss"):
            stem = token[:-1]
        elif len(token) > 3 and token.endswith("e"):
            stem = token[:-1]
        else:
            return token
        if stem == token:
            return token
        token = stem


def _admission_english_suffix_stem(stem: str) -> str:
    """Restore the silent ``-e`` a vowel-initial suffix displaced.

    Only a stem too short to stand alone needs this: a longer one drops its
    own ``-e`` above, so the two forms already meet.  ``use``/``using`` did
    not, and no suffix rule could fix that without also cutting a word in
    half, which is why the letter comes back instead.
    """

    return f"{stem}e" if len(stem) < 3 else stem


# A Korean predicate marks past tense by closing its syllable with ``ㅆ``, so
# every syllable a word writes after that marker is ending rather than stem.
_ADMISSION_KOREAN_PAST_CODA = 20
_ADMISSION_KOREAN_LIGHT_VERB_TAIL = re.compile(r"(?:하|되|받|시키)$")


def _admission_korean_tense_stem(word: str) -> str:
    """Drop a Korean past marker, the ending after it, and the light verb under it.

    The shared contract reads the endings a market closes a sentence with
    (``되었습니다``) and the ones it carries a clause forward with (``되며``),
    but not the two combined -- and the combination is what prose writes
    whenever a measured result leads into the conditions it was measured under
    (``확인되었으며``, ``감소했고``).  A word registered once has to compare
    equal to the same word read back out of prose, and there it did not: the
    same predicate was exempt in one spelling and charged in another, so no
    Korean sentence could report a result at all.

    This removes tense and the ending stacked on it, never content: what is
    left is the nominal the light verb turned into a predicate, which is the
    form the contract itself produces for every other ending of that word.
    """

    cut = 0
    for index, char in enumerate(word):
        if index and "\uac00" <= char <= "\ud7a3" and (ord(char) - 0xAC00) % 28 == _ADMISSION_KOREAN_PAST_CODA:
            cut = index
    if not cut:
        return word
    return _ADMISSION_KOREAN_LIGHT_VERB_TAIL.sub("", word[:cut]) or word[:cut]


# The polite declarative ``-(스)ㅂ니다`` is spelled two ways.  After a consonant
# it is a syllable of its own (``돕습니다``) and the shared contract's inventory
# of endings removes it there.  After a vowel the ``ㅂ`` fuses into the syllable
# it closes (``줍니다``, ``갑니다``), where no inventory can list it: the ending
# is written inside the stem.  So the fused spelling is read off the coda, the
# way the past marker above it is.
#
# This is why one Korean predicate was exempt in one spelling and charged in
# another.  ``도움이 됩니다`` reduced to a registered light verb, while its
# ``도움을 줍니다`` twin reduced to nothing at all, so the same recorded benefit
# was supported written one way and unsupported written the other -- and
# English, whose source atoms are already predicates and need no auxiliary
# (``soothes skin``), was supported either way.  Neither locale gets a reader
# of its own here; both get the same one.
_ADMISSION_KOREAN_POLITE_CODA = 17
_ADMISSION_KOREAN_POLITE_TAIL = "니다"
# ``습`` closes with the same ``ㅂ``, so the two allomorphs are spelled alike at
# the coda.  It is the syllabic one, which the shared reduction has already
# had its chance at, and stripping its coda would leave a stem no word has.
_ADMISSION_KOREAN_POLITE_ALLOMORPH = "습"


def _admission_korean_polite_stem(word: str) -> str:
    """Drop the polite declarative ending that is spelled inside its own stem."""

    if not word.endswith(_ADMISSION_KOREAN_POLITE_TAIL):
        return word
    head = word[: -len(_ADMISSION_KOREAN_POLITE_TAIL)]
    if not head or head.endswith(_ADMISSION_KOREAN_POLITE_ALLOMORPH) or not ("\uac00" <= head[-1] <= "\ud7a3"):
        return word
    offset = ord(head[-1]) - 0xAC00
    if offset % 28 != _ADMISSION_KOREAN_POLITE_CODA:
        return word
    return f"{head[:-1]}{chr(0xAC00 + offset - _ADMISSION_KOREAN_POLITE_CODA)}"


def _admission_token_stem(word: str) -> str:
    """Reduce one word to the single form this comparison counts it as.

    Each market marks a word's role its own way -- Korean on the word itself,
    English with a suffix -- so the Korean answer is read from the shared
    contract and the English one from the rule above.  Every reader here that
    compares one word against another reads both from this one place, so no
    list of words is reduced by one rule and then measured against another.

    A word that is nothing but role marking counts as no word at all.  Korean
    spells pure predication as a word of its own (``합니다`` where English
    writes a separate auxiliary already registered as scaffold), so a sentence
    that only re-ended its source's predicate -- ``…견고하게 합니다`` beside
    ``…견고하게 하는`` -- looked like it stated a word the source never used.
    Dropping it states nothing either way: the same reduction runs on the
    source, and a sentence has to keep a word of its own to be supported at
    all.

    Tense is role marking too, and the contract's inventory of endings does not
    cover it where a connective is stacked on it, so it is removed here before
    the shared reduction runs.  Neither can an inventory cover an ending that
    fuses into the syllable it closes, so the polite declarative is read off
    the coda afterwards.
    """

    token = word.casefold()
    if not re.search(r"[가-힣]", token):
        return _admission_english_stem(token)
    if korean_word_is_role_marking_only(token):
        return ""
    return _admission_korean_polite_stem(korean_content_stem(_admission_korean_tense_stem(token)))


def _admission_exempt_stems(*words: str) -> frozenset[str]:
    """Register words a comparison may ignore, in the form it actually reads.

    An exempt list is matched by identity against the words a comparison
    produces, and these lists were written as surface forms while the
    comparison reads stems.  Twelve of 84 scaffold words were strings the
    reader can never produce (``includes``, ``shows``, ``this``, ``있습니다``),
    as were 12 of 30 metric words and 5 of 36 frame words, so a word exempted
    in one spelling was charged in another -- which is why the same word was
    written here in two and three spellings, and why ``효과`` stood in the
    frame list while the reader only ever saw ``효``.  Registering every word
    through the one reduction the comparison uses makes a single entry cover
    each of that word's forms, so the spellings that differed only by
    inflection are gone rather than repeated.

    Reviving an entry only takes a word off the answer's side of the
    comparison, and every list here is scoped to words that present a claim
    rather than state one, so nothing revived carries a number, a cause, a
    fit, a safety conclusion, or a comparison with it.  The comparison also
    still requires the answer to keep at least one content word of its own, so
    a sentence assembled out of these words alone is supported by nothing.
    """

    return frozenset(
        stem
        for word in words
        for raw in _ADMISSION_TOKEN_WORD.findall(word.casefold())
        if (stem := _admission_token_stem(raw))
    )


_ADMISSION_CARD_SCAFFOLD_TOKENS = _admission_exempt_stems(
    # A connective joins two clauses and states nothing of its own, so the
    # set already carries ``and``, ``or``, ``that`` and ``which``.  The
    # subordinators below were missing, and a sentence that gave its reason
    # (``… is recommended because X supports the barrier``) then looked like
    # it asserted a word its source never used.
    "because",
    "since",
    "while",
    "when",
    "but",
    "so",
    "though",
    "although",
    "때문",
    "덕분",
    "또한",
    "그리고",
    "하지만",
    "그래서",
    "a",
    "an",
    "and",
    "also",
    "as",
    "assessment",
    "at",
    "be",
    "by",
    "choice",
    "consider",
    "contain",
    "feature",
    "for",
    "from",
    "has",
    "have",
    "include",
    "in",
    "is",
    "it",
    "its",
    "list",
    "among",
    "may",
    "might",
    "of",
    "option",
    "on",
    "or",
    "product",
    "recommend",
    "report",
    "right",
    "s",
    "show",
    "stat",
    "the",
    "that",
    "suitable",
    "this",
    "to",
    "was",
    "were",
    "which",
    "with",
    "고려",
    "관리",
    "목표",
    "라면",
    "이라면",
    "수",
    "있습니다",
    "추천",
    "選択",
    "検討",
    "目的",
    "なら",
)
# What a measured record needs from a sentence, beyond the value itself, is the
# attribution that the value was *obtained*: read off a study rather than
# asserted by the page.  That attribution is grammar laid over the record --
# the record's value, the outcome it measured, and the study scope it was
# measured under are each matched against the record independently -- so it
# adds no fact whichever word a market spells it with, and both markets are
# written here together.  Listing the English half alone is why no Korean
# measured sentence could be published at all: ``확인되었으며`` was charged as
# an invented phrase while ``showed`` beside it was not.
#
# What was measured and how it was measured are deliberately absent.  An
# outcome (``개선``, ``감소``, ``improve``, ``reduce``) is the direction the
# record measured in, and a sentence that supplies one the record does not file
# has turned a figure into a result; a method (``시험``, ``측정``, ``clinical``)
# is a scope slot, and a slot the record left empty may not be filled from the
# answer.  Both were exempt here before, which let a measured answer conclude
# more than its record did, so both are charged now.
_ADMISSION_METRIC_REPORTING_TOKENS = _admission_exempt_stems(
    "agree",
    "confirm",
    "demonstrate",
    "found",
    "find",
    "indicate",
    "observe",
    "record",
    "report",
    "show",
    "확인",
    "관찰",
    "보고",
    "집계",
    "나타났",
)
# The words a sentence uses to *present* a claim rather than to state it, in
# every market rather than one.  Three closed classes:
#
#   the role the claim plays, named  -- ``ingredient``/``성분``, ``benefit``/``효능``;
#   the attribution the source wrote -- ``stat``, ``설명``, ``안내``, ``제시``;
#   the attenuation the answer adds  -- ``돕``/``도움``, which states the source's
#                                       fact more weakly, never more strongly.
#
# Extraction writes the attribution frame into the source itself (``…으로
# 설명됩니다``), so a source sentence and an answer restating it routinely differ
# only here.  Listing the English half alone is what made a natural Korean
# sentence look like it asserted something its source never said: adding
# ``…개선을 돕고`` to a supported clause removed its support while adding no
# fact.  A category noun is safe to drop because what tells two claims apart is
# the modifier in front of it -- ``아미노산 유래 세정 성분`` against ``판테놀``
# still differs once ``성분`` is gone.  Only the answer's side is reduced: the
# answer may frame a fact the source states, never state one it does not.
_ADMISSION_CARD_CLAIM_FRAME_TOKENS = _admission_exempt_stems(
    "among",
    "benefit",
    "ingredient",
    "list",
    "stat",
    "성분",
    "효능",
    "효과",
    "설명",
    "안내",
    "제시",
    "소개",
    "표기",
    "기재",
    "돕",
    "돕고",
    "도움",
    # Every form of the containment frame, read from the one definition the
    # final proofreader reads.  A containment anchors the ingredient to the
    # product whose page states it, which the card already records, so the
    # word states no fact beyond the claim -- and a product-scope sentence
    # joins the containment to the outcome instead of closing on it
    # (``판테놀과 베타인을 담아 …을 돕습니다``), so the adnominal forms alone left
    # the join itself charged as a word no record carried.
    *KOREAN_CONTAINMENT_FRAME_FORMS,
    # ``하``/``되`` are the light-verb stems the sentence-form contract also
    # reads: they carry the grammar of a predicate and none of its content,
    # so a derived predicate (``견고하게 하는``) states the stem beside it.
    "하",
    "되",
    # The same light verb standing alone as an adnominal -- ``대상으로 한
    # 시험``, ``함유된`` -- is the form the reader actually produces for it: the
    # shared reduction leaves a one-syllable word whole to keep from cutting a
    # noun in half, so ``하`` was exempt in one spelling and charged in
    # another.  The numeral that shares the spelling always writes the counter
    # it counts (``한 명``), and that counter is charged on its own.
    "한",
    "된",
    # ``주`` closes the same class: the benefactive auxiliary is how Korean says
    # a predicate is performed for someone (``도움을 줍니다``, ``세정해 줍니다``),
    # so it carries the grammar of doing-for and none of the content.  Leaving
    # it out is what charged the most natural rendering of a recorded benefit
    # while admitting the same claim under ``됩니다`` and ``돕습니다``.
    #
    # It reaches this entry only from that auxiliary now.  A noun whose last
    # syllable is spelled like a particle used to reduce to its first syllable,
    # so ``주의`` -- a safety caution no record filed -- arrived here as ``주``
    # and was set aside as grammar; the reduction keeps such a noun whole, and
    # the noun that shares this spelling outright always writes the period it
    # counts (``주 2회``), whose counter is charged on its own.
    "주",
    *(noun for noun in GENERIC_ENTITY_NOUNS if not noun.isascii() or len(noun) > 2),
)
# A recommendation names its target with neutral grammar of its own, and these
# are those carriers rather than any target.  The conditional endings that a
# question wraps a target in never appear on one of them, so the stem
# registered here is the form the anchor reader compares.
_ADMISSION_BUYER_ANCHOR_CARRIER_TOKENS = _admission_exempt_stems(
    "care",
    "choice",
    "consider",
    "customer",
    "fit",
    "focus",
    "goal",
    "look",
    "need",
    "option",
    "people",
    "recommend",
    "routine",
    "seek",
    "those",
    "want",
    "worth",
    "고객",
    "관리",
    "관리하",
    "고려",
    "목표",
    "사용자",
    "선택",
    "싶",
    "추천",
    "케어",
    "함께",
)
# The conditional endings a question wraps its target in.  Everything else a
# Korean word carries -- its particle, its finite ending -- is the shared
# inflection contract's to remove.
_ADMISSION_KOREAN_ANCHOR_SUFFIXES = ("이라면", "라면", "다면", "인", "만", "고")


def _admission_sentences(value: str) -> list[str]:
    return [item.strip() for item in _ADMISSION_SENTENCE_SPLIT.split(value) if item.strip()]


def _admission_normalize(value: str) -> str:
    return re.sub(r"[^\w가-힣ぁ-んァ-ン一-龯]+", "", value.casefold())


def _admission_tokens(value: str) -> list[str]:
    tokens: list[str] = []
    for raw in re.findall(r"[A-Za-z가-힣ぁ-んァ-ン一-龯][A-Za-z0-9가-힣ぁ-んァ-ン一-龯-]*", value.casefold()):
        token = raw.strip("-")
        if not token or token in {"a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "this", "to", "with", "what", "which", "does", "do", "how"}:
            continue
        if len(token) > 5 and token.endswith("ies"):
            token = f"{token[:-3]}y"
        elif len(token) > 4 and token.endswith("es"):
            token = token[:-2]
        elif len(token) > 3 and token.endswith("s"):
            token = token[:-1]
        if token and token not in tokens:
            tokens.append(token)
    return tokens


def _admission_product_tokens(product: Mapping[str, Any]) -> set[str]:
    tokens: set[str] = set()
    for value in (product.get("name"), product.get("originalName"), product.get("brand"), product.get("category")):
        tokens.update(_admission_tokens(clean_text(value)))
    return tokens


def _admission_locale_is_supported(text: str, locale: str) -> bool:
    compact = re.sub(r"\s+", "", text)
    hangul = len(re.findall(r"[가-힣]", compact))
    kana = len(re.findall(r"[ぁ-んァ-ン]", compact))
    han = len(re.findall(r"[一-龯]", compact))
    japanese = kana + han
    latin = len(re.findall(r"[A-Za-z]", compact))
    if locale == "ko-KR":
        return hangul > 0 and japanese < max(3, hangul * 0.2) and latin <= max(16, hangul * 1.5)
    if locale == "ja-JP":
        return kana > 0 and hangul == 0 and latin <= max(14, japanese * 1.5)
    return latin > 0 and (hangul + japanese) <= max(2, latin // 12)


def _admission_numeric_tokens(text: str, product_name: str) -> set[str]:
    """Return the numbers a text measures with, not the ones inside the name.

    A title carries digits of its own (``BarrierCare365``, ``Serum VI 90ml``), and
    copy names the product under more than one surface: the recorded title and
    that title without its pack qualifier.  Masking only the recorded spelling
    leaves the name's own digits behind whenever the copy uses the shorter one,
    and the answer then looks like it published a measurement.
    """

    masked = text
    for surface in sorted(_admission_product_name_surfaces({"name": product_name}), key=len, reverse=True):
        masked = re.sub(re.escape(surface), " ", masked, flags=re.IGNORECASE)
    return {re.sub(r"\s+", "", match.group()).casefold() for match in _ADMISSION_NUMBER.finditer(masked)}


def _admission_evidence_roles_support_text(text: str, evidence: Sequence[Mapping[str, Any]]) -> bool:
    roles = {clean_text(item.get("role")) for item in evidence}
    return all(not pattern.search(text) or bool(roles & allowed) for _, pattern, allowed in _ADMISSION_TOPIC_PATTERNS)


def _admission_context_is_supported(sentence: str, evidence: Sequence[Mapping[str, Any]]) -> bool:
    evidence_text = " ".join(clean_text(item.get("text")) for item in evidence)
    return all(not pattern.search(sentence) or pattern.search(evidence_text) is not None for pattern in _ADMISSION_CONTEXTS)


def _admission_has_review_attribution(sentence: str, evidence: Sequence[Mapping[str, Any]]) -> bool:
    sentence_tokens = set(_admission_tokens(sentence))
    public_reviews = [item for item in evidence if _admission_is_public_review_evidence(item)]
    if _ADMISSION_REVIEW_CLAIM.search(sentence) is not None:
        return (
            bool(public_reviews)
            and _ADMISSION_REVIEW_ATTRIBUTION.search(sentence) is not None
            and any(
                (review_tokens := set(_admission_tokens(clean_text(item.get("text")))))
                and len(sentence_tokens & review_tokens) >= min(2, len(review_tokens))
                for item in public_reviews
            )
        )
    for item in public_reviews:
        review_tokens = set(_admission_tokens(clean_text(item.get("text"))))
        if review_tokens and len(sentence_tokens & review_tokens) >= min(2, len(review_tokens)):
            return _ADMISSION_REVIEW_ATTRIBUTION.search(sentence) is not None
    return True


def _admission_causal_relation_is_supported(
    sentence: str, evidence: Sequence[Mapping[str, Any]], product: Mapping[str, Any]
) -> bool:
    if _ADMISSION_CAUSAL.search(sentence) is None:
        return True
    ingredient_tokens = {
        token
        for value in [*as_list(product.get("ingredients")), *as_list(as_dict(product.get("semanticFacts")).get("ingredients"))]
        for token in _admission_tokens(clean_text(value))
    }
    benefit_tokens = {
        token
        for value in [
            *as_list(product.get("benefits")),
            *as_list(product.get("effects")),
            *as_list(as_dict(product.get("semanticFacts")).get("benefits")),
            *as_list(as_dict(product.get("semanticFacts")).get("effects")),
        ]
        for token in _admission_tokens(clean_text(value))
    }
    sentence_tokens = set(_admission_tokens(sentence))
    if not (sentence_tokens & ingredient_tokens and sentence_tokens & benefit_tokens):
        return False
    return any(
        _ADMISSION_CAUSAL.search(source) is not None
        and len(sentence_tokens & set(_admission_tokens(source))) >= max(2, len(sentence_tokens) // 2)
        for item in evidence
        for source in _admission_sentences(clean_text(item.get("text")))
    )


def _admission_metrics_are_qualified(text: str, evidence: Sequence[Mapping[str, Any]], product_name: str) -> bool:
    for sentence in _admission_sentences(text):
        numbers = _admission_numeric_tokens(sentence, product_name)
        if not numbers:
            continue
        matches: list[tuple[Mapping[str, Any], str]] = []
        for item in evidence:
            for source in _admission_sentences(clean_text(item.get("text"))):
                if numbers <= _admission_numeric_tokens(source, product_name):
                    matches.append((item, source))
        if not matches:
            return False
        if not any(
            not isinstance(item.get("ocrConfidence"), int | float)
            or isinstance(item.get("ocrConfidence"), bool)
            or float(item["ocrConfidence"]) >= 0.6
            for item, _ in matches
        ):
            return False
        related_evidence = " ".join(clean_text(item.get("text")) for item, _ in matches)
        source_timings = {_admission_normalize(value) for value in _ADMISSION_TIMING.findall(related_evidence)}
        output_timings = {_admission_normalize(value) for value in _ADMISSION_TIMING.findall(sentence)}
        if source_timings and not source_timings <= output_timings:
            return False
        if _ADMISSION_METHOD.search(related_evidence) is not None and _ADMISSION_METHOD.search(sentence) is None:
            return False
        if _ADMISSION_CAVEAT.search(related_evidence) is not None and _ADMISSION_CAVEAT.search(text) is None:
            return False
        if _ADMISSION_COMPARISON.search(related_evidence) is not None and _ADMISSION_COMPARISON.search(sentence) is None:
            return False
    return True


# The words English marks a question with.  They are function words, so the
# closed class is named; where one stands is the rule, and it is read below.
_ADMISSION_ENGLISH_INTERROGATIVE = (
    "what|which|who|whom|whose|when|where|why|how|for|if"
    "|is|are|was|were|do|does|did|can|could|should|shall|will|would|has|have|am|may|might"
)
# A question marks itself in the clause that does the asking, and English puts
# that clause wherever the sentence needs it: at the head, after the situation
# the reader states first (``For fine lines, which serum …``), or after a
# coordinator that joins the two (``I have dry skin, so which cleanser …``).
# Requiring the marker at the very start of the text -- and forbidding any
# ``?`` before the end -- refused exactly the shape the FAQ prompt asks for,
# "start every question with a real customer situation", whenever the situation
# was written as a clause of its own rather than as a phrase.  Korean was never
# read that way: its branch looks only at the ending, which stands at the end
# of the asking clause wherever that clause is.
_ADMISSION_ENGLISH_ASKING_CLAUSE = re.compile(
    rf"(?:^|[,;:]\s+|\b(?:so|and|but|then|or)\s+)(?:{_ADMISSION_ENGLISH_INTERROGATIVE})\b",
    re.IGNORECASE,
)


def _admission_english_text_asks(text: str) -> bool:
    """Return whether an English text asks a question.

    The question is the last thing the text does, so the sentence that closes
    it has to be the one asking: a text may set the situation out in its own
    sentence first (``After cleansing my skin feels dry. Which cleanser …?``)
    and that earlier sentence asserts rather than asks.
    """

    sentences = _admission_sentences(text)
    last = clean_text(sentences[-1]) if sentences else clean_text(text)
    if not last.endswith("?"):
        return False
    return _ADMISSION_ENGLISH_ASKING_CLAUSE.search(last) is not None


def _admission_text_is_coherent(text: str, kind: str = "statement") -> bool:
    if not text or _ADMISSION_COPY_ARTIFACT.search(text) is not None or _ADMISSION_COMPRESSED_METRICS.search(text) is not None:
        return False
    sentences = _admission_sentences(text)
    if not sentences or not all(len(_admission_tokens(sentence)) >= 1 for sentence in sentences):
        return False
    if kind == "fragment":
        return True
    hangul = len(re.findall(r"[가-힣]", text))
    kana = len(re.findall(r"[ぁ-んァ-ン]", text))
    latin = len(re.findall(r"[A-Za-z]", text))
    if hangul >= max(2, kana, latin * 0.2):
        if kind == "question":
            return re.search(r"(?:인가요|한가요|일까요|나요|까요|습니까|무엇인가요|어떤가요)[?？]?$", text) is not None
        if kind == "action":
            return is_concrete_usage_action(text) and re.search(r"(?:다|요|니다|습니다)[.!?。！？]?$", text) is not None
        return re.search(r"(?:다|요|니다|습니다|입니다|합니다|됩니다|있습니다|없습니다)[.!?。！？]?$", text) is not None
    if kana >= 1:
        if kind == "question":
            return re.search(r"(?:ですか|ますか|でしょうか|ますでしょうか|か)[?？。]?$", text) is not None
        if kind == "action":
            return is_concrete_usage_action(text) and re.search(r"(?:ます|ください|する|します|なじませる|塗る|洗う|流す)[.!?。！？]?$", text) is not None
        return re.search(r"(?:です|ます|ません|でした|でしょう|あります|います|できます|します|なります)[.!?。！？]?$", text) is not None
    if latin >= 3:
        if kind == "question":
            return _admission_english_text_asks(text)
        if kind == "action":
            return is_concrete_usage_action(text)
        return re.search(
            r"\b(?:is|are|was|were|has|have|works?|contains?|includes?|provides?|supports?|helps?|improves?|offers?|features?|"
            r"describes?|shows?|showed|found|finds?|reports?|reported|agrees?|agreed|observes?|observed|"
            r"demonstrates?|demonstrated|indicates?|indicated|increases?|increased|decreases?|decreased|"
            r"reduces?|reduced|improved|allows?|lets?|lists?|mentions?|notes?|noted|receives?|received|can|could|may|might|will)\b",
            text,
            re.IGNORECASE,
        ) is not None
    return False


def _admission_text_is_supported(
    text: str,
    evidence: Sequence[Mapping[str, Any]],
    product: Mapping[str, Any],
    locale: str,
    coherence_kind: str = "statement",
) -> bool:
    if not _admission_locale_is_supported(text, locale) or not _admission_text_is_coherent(text, coherence_kind):
        return False
    sentences = _admission_sentences(text)
    closed_review_sentences = {
        sentence for sentence in sentences if _admission_has_closed_positive_review_frame_support(sentence, evidence)
    }
    ordinary_text = " ".join(sentence for sentence in sentences if sentence not in closed_review_sentences)
    if ordinary_text and not _admission_evidence_roles_support_text(ordinary_text, evidence):
        return False
    product_name = clean_text(product.get("name"))
    if ordinary_text and not _admission_metrics_are_qualified(ordinary_text, evidence, product_name):
        return False
    for sentence in sentences:
        if sentence not in closed_review_sentences:
            if not _admission_context_is_supported(sentence, evidence):
                return False
            if not _admission_has_review_attribution(sentence, evidence):
                return False
            if not _admission_causal_relation_is_supported(sentence, evidence, product):
                return False
        if not sentence_evidence_has_direct_claim_support(sentence, evidence):
            return False
    return True


def _admission_has_closed_positive_review_frame_support(sentence: str, evidence: Sequence[Mapping[str, Any]]) -> bool:
    """Recognize only final-provenance-bound positive keyword or rating frames.

    The final proofreader owns the exact English/Korean grammar, identity,
    source-path, polarity, rating/count, and scale checks.  Admission merely
    recognizes the selected result so a customer noun or a rating number is
    not reclassified as an unrelated audience or metric claim.  A body,
    unknown review field, or unselected positive atom cannot take this path.
    """

    selected = select_rendered_sentence_evidence(sentence, evidence, ("identity", "review"))
    sentence_ids = selected["sentenceEvidenceIds"]
    selected_ids: set[str] = set(sentence_ids[0]) if len(sentence_ids) == 1 else set()
    if not selected_ids:
        return False
    return any(
        clean_text(item.get("id")) in selected_ids
        and _admission_is_public_review_evidence(item)
        and (
            re.fullmatch(r"product\.reviews\.keywords\[\d+\]", clean_text(item.get("sourcePath"))) is not None
            or clean_text(item.get("sourcePath")) == "product.reviews.summary"
        )
        for item in evidence
    )


def _admission_role_position(text: str, evidence: Sequence[Mapping[str, Any]], roles: frozenset[str]) -> int | None:
    """Return a role's first position only when final provenance selects it.

    A broad direct-claim predicate can match the product entity in a later
    benefit atom and incorrectly place that benefit at the opening sentence.
    More importantly, a review atom merely present in the ledger must not
    become implicit description coverage.  Reuse the final sentence selector
    so ordering follows the exact evidence that binds each generated sentence.
    """

    role_ids = {
        clean_text(item.get("id"))
        for item in evidence
        if clean_text(item.get("role")) in roles and clean_text(item.get("id"))
    }
    if not role_ids:
        return None
    evidence_roles = _unique_strings([clean_text(item.get("role")) for item in evidence])
    selected = select_rendered_sentence_evidence(text, evidence, evidence_roles)
    cursor = 0
    positions: list[int] = []
    lowered = text.casefold()
    for sentence, sentence_ids in zip(
        _admission_sentences(text), selected["sentenceEvidenceIds"], strict=True
    ):
        position = lowered.find(sentence.casefold(), cursor)
        cursor = position + len(sentence) if position >= 0 else cursor
        if role_ids.intersection(sentence_ids):
            positions.append(position if position >= 0 else cursor)
    if positions:
        return min(positions)
    # Provenance publication asks which evidence a sentence is published
    # against, and answers it from the renderer's own sentence frames.  Role
    # coverage asks something weaker: whether the paragraph states this role's
    # source material anywhere.  A sentence that spells the atom out -- the
    # audience in "…is a serum for dry skin" -- states that role whether or not
    # a frame claimed the sentence for a different one, and a natural sentence
    # no frame anticipated states it too.  Reading coverage from the publication
    # decision made every unanticipated shape look like an omitted role, in
    # every locale.  Nothing is admitted by this: whether the paragraph may be
    # published is decided by its support and binding checks, not here.
    return _admission_role_atom_position(text, evidence, roles)


def _admission_role_atom_position(
    text: str, evidence: Sequence[Mapping[str, Any]], roles: frozenset[str]
) -> int | None:
    """Return where the text first states a source atom carrying one of these roles."""

    positions = [
        match.start()
        for item in evidence
        if clean_text(item.get("role")) in roles and (atom := clean_text(item.get("text")))
        for match in source_phrase_matches(text, atom)
    ]
    return min(positions) if positions else None


def _admission_description_roles_are_ordered(text: str, evidence: Sequence[Mapping[str, Any]]) -> bool:
    role_order = (
        frozenset({"identity", "description", "audience", "concern"}),
        frozenset({"ingredient", "formula"}),
        frozenset({"benefit", "effect"}),
        frozenset({"metric"}),
        frozenset({"usage"}),
        frozenset({"review"}),
    )
    positions = [position for roles in role_order if (position := _admission_role_position(text, evidence, roles)) is not None]
    return positions == sorted(positions)


def _admission_is_narrative_description(text: str) -> bool:
    return len(_admission_sentences(text)) > 1 or len(_admission_tokens(text)) >= 12


def _admission_descriptions_are_too_similar(left: str, right: str) -> bool:
    left_normalized, right_normalized = _admission_normalize(left), _admission_normalize(right)
    if not left_normalized or not right_normalized:
        return False
    if left_normalized == right_normalized or left_normalized in right_normalized or right_normalized in left_normalized:
        return True
    left_tokens, right_tokens = set(_admission_tokens(left)), set(_admission_tokens(right))
    denominator = min(len(left_tokens), len(right_tokens))
    return denominator >= 3 and len(left_tokens & right_tokens) / denominator >= 0.8


def _admission_description_is_supported(
    text: str,
    evidence: Sequence[Mapping[str, Any]],
    product: Mapping[str, Any],
    locale: str,
    field: str,
) -> bool:
    if not _admission_text_is_supported(text, evidence, product, locale):
        return False
    if _admission_description_contains_question(text):
        return False
    if not _admission_description_roles_are_ordered(text, evidence):
        return False
    if field != "webPageDescription":
        return True
    if _admission_webpage_copies_usage_row(text, product):
        return False
    if _ADMISSION_STIFF_PAGE_WRAPPER.search(text) is not None and not _admission_has_bound_natural_korean_page_overview(
        text, evidence
    ):
        return False
    # A one-line source description can safely populate both schema surfaces
    # when no richer page narrative exists.  Rich model prose must identify a
    # real page role rather than repeat a Product narrative under a new node.
    return not _admission_is_narrative_description(text) or _ADMISSION_PAGE_REFERENCE.search(text) is not None


def _admission_has_bound_natural_korean_page_overview(
    text: str,
    evidence: Sequence[Mapping[str, Any]],
) -> bool:
    """Allow only a finite, sentence-bound Korean page-coverage opener."""

    sentences = _admission_sentences(text)
    if not sentences:
        return False
    match = _ADMISSION_KOREAN_NATURAL_PAGE_OVERVIEW.fullmatch(sentences[0])
    if match is None:
        return False
    labels = [clean_text(value) for value in re.split(r"\s*,\s*|\s+및\s+", clean_text(match.group("coverage")))]
    if not labels or any(label not in _ADMISSION_KOREAN_PAGE_OVERVIEW_LABELS for label in labels):
        return False
    roles = _unique_strings([clean_text(item.get("role")) for item in evidence])
    selected = select_rendered_sentence_evidence(sentences[0], evidence, roles)
    return len(selected["sentenceEvidenceIds"]) == 1 and bool(selected["sentenceEvidenceIds"][0])


def _admission_description_contains_question(text: str) -> bool:
    """Descriptions are declarations; source FAQ prompts belong in FAQPage only."""

    return any(
        sentence.rstrip().endswith(("?", "？")) or _ADMISSION_ASSERTIVE_QUESTION.search(sentence) is not None
        for sentence in _admission_sentences(text)
    )


def _admission_webpage_copies_usage_row(text: str, product: Mapping[str, Any]) -> bool:
    """Reject raw procedure copy in a page overview while retaining usage coverage prose."""

    source_steps = [
        clean_text(value)
        for value in [
            *as_list(product.get("usage")),
            *as_list(as_dict(product.get("semanticFacts")).get("usageSteps")),
        ]
        if clean_text(value)
    ]
    return any(
        _usage_actions_match(sentence, source_step)
        for sentence in _admission_sentences(text)
        for source_step in source_steps
    )


def _admission_description_has_complete_final_bindings(
    text: str,
    evidence: Sequence[Mapping[str, Any]],
    field: str,
) -> bool:
    """Require the plan's own evidence to bind every admitted description sentence.

    Admission already checks semantic support, but final provenance additionally
    selects the exact evidence records for each rendered sentence.  Repeating
    that public selector here prevents a model-plan sentence with broad lexical
    overlap from being admitted only to become an unbound final artifact.
    """

    base_roles = (
        "identity",
        "description",
        "benefit",
        "effect",
        "ingredient",
        "audience",
        "metric",
        "review",
        "source",
    )
    if field == "webPageDescription":
        base_roles = (*base_roles, "usage", "faq")
    roles = _unique_strings([*base_roles, *(clean_text(item.get("role")) for item in evidence)])
    selected = select_rendered_sentence_evidence(text, evidence, roles)
    sentence_ids = selected["sentenceEvidenceIds"]
    return len(sentence_ids) == len(_admission_sentences(text)) and bool(sentence_ids) and all(sentence_ids)


def _admission_faq_has_complete_final_bindings(
    question: str,
    answer: str,
    evidence: Sequence[Mapping[str, Any]],
) -> bool:
    """Keep only FAQ pairs that final public-copy provenance can bind in full.

    Model-plan FAQ rows may cite a broad set of source facts. Semantic
    admission alone can accept a combined assertion even when no individual
    record supports the rendered question or answer. Reuse the exact final
    sentence selector here so that such a row falls back before it can turn
    into a publish-blocking provenance warning later in the pipeline.
    """

    roles = _unique_strings(
        [
            "identity",
            "description",
            "benefit",
            "effect",
            "ingredient",
            "audience",
            "usage",
            "metric",
            "faq",
            "review",
            "source",
            "commerce",
            *(clean_text(item.get("role")) for item in evidence),
        ]
    )
    for text in (question, answer):
        selected = select_rendered_sentence_evidence(text, evidence, roles)
        sentence_ids = selected["sentenceEvidenceIds"]
        if len(sentence_ids) != len(_admission_sentences(text)) or not sentence_ids or not all(sentence_ids):
            return False
    return True


def _admission_faq_card_has_complete_bindings(
    question: str,
    answer: str,
    evidence: Sequence[Mapping[str, Any]],
    card: Mapping[str, Any],
    product: Mapping[str, Any],
    locale: str,
) -> bool:
    """Validate a relation-card Q&A without requiring a source to word its question.

    A customer question is a query rather than a factual source sentence. The
    selected card binds its product identity and allowed claims; every answer
    sentence still has to be independently supported by the cited records. A
    product/brand prefix is an identity scaffold, not an unsupported efficacy
    assertion. The renderer carries this same stable membership into final
    provenance.
    """

    if not _admission_is_customer_decision_question(question, product, locale):
        return False
    if not _admission_locale_is_supported(question, locale):
        return False
    if not _admission_text_is_coherent(question, "question"):
        return False
    claim_ids = {
        clean_text(identifier)
        for raw_claim in as_list(card.get("claims"))
        for identifier in as_list(as_dict(raw_claim).get("evidenceIds"))
        if clean_text(identifier)
    }
    cited_ids = {clean_text(item.get("id")) for item in evidence if clean_text(item.get("id"))}
    if not cited_ids or not cited_ids.issubset(claim_ids):
        return False
    return _admission_card_answer_is_supported(answer, evidence, card, product, locale)


def _admission_card_claims_for_evidence(
    card: Mapping[str, Any], evidence: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    """Return only card claims whose recorded evidence is in the row scope."""

    cited_ids = {clean_text(item.get("id")) for item in evidence if clean_text(item.get("id"))}
    claims: list[dict[str, Any]] = []
    for raw_claim in as_list(card.get("claims")):
        claim = as_dict(raw_claim)
        claim_ids = {clean_text(identifier) for identifier in as_list(claim.get("evidenceIds")) if clean_text(identifier)}
        if claim_ids and claim_ids & cited_ids:
            claims.append(claim)
    return claims


def _admission_buyer_decision_has_source_grounded_reason(
    answer: str,
    claims: Sequence[Mapping[str, Any]],
    product: Mapping[str, Any],
    locale: str,
) -> bool:
    """Require a buyer recommendation to retain its card's formula/effect reason.

    The first sentence may naturally introduce the customer situation and
    product choice.  It cannot, by itself, turn a cited audience or concern
    into a useful recommendation.  An explicitly sourced formula/effect link
    may be retained in one sentence.  When the source keeps formula and
    benefit independent, both must remain in the answer as independently
    supported sentences; the caller separately rejects an invented causal
    merge.
    """

    sentences = _admission_sentences(answer)
    if not sentences:
        return False
    explicit_links = [
        claim
        for claim in claims
        if clean_text(claim.get("role")) == "ingredient-effect"
        and clean_text(claim.get("relationship")) == "explicit"
    ]
    if explicit_links:
        return any(
            _admission_card_sentence_or_clause_matches_claim(sentence, claim, product)
            for sentence in sentences
            for claim in explicit_links
        )

    formula_claims = [
        claim for claim in claims if clean_text(claim.get("role")) in {"ingredient", "formula"}
    ]
    benefit_claims = [
        claim for claim in claims if clean_text(claim.get("role")) in {"benefit", "effect"}
    ]
    if not formula_claims or not benefit_claims:
        return False
    formula_retained = any(
        _admission_card_sentence_or_clause_matches_claim(sentence, claim, product)
        for sentence in sentences
        for claim in formula_claims
    )
    benefit_retained = any(
        _admission_card_sentence_or_clause_matches_claim(sentence, claim, product)
        or _admission_independent_benefit_customer_voice_matches(sentence, claim, claims, product, locale)
        for sentence in sentences
        for claim in benefit_claims
    )
    return formula_retained and benefit_retained


def _admission_card_answer_is_supported(
    answer: str,
    evidence: Sequence[Mapping[str, Any]],
    card: Mapping[str, Any],
    product: Mapping[str, Any],
    locale: str,
) -> bool:
    """Bind every natural answer sentence to one selected card-scoped claim.

    An answer is supported when each of its sentences states something this
    card records and none of them states anything else, and when the answer as
    a whole states at least one recorded fact -- a sentence that only calls the
    product by name is admitted because it asserts nothing, which is also why
    an answer made of those alone answers nothing.  Where the card carries a
    measurement, the scope that record filed has to reach the shopper somewhere
    in the answer; which sentence carries it is the prose's choice.
    """

    sentences = _admission_sentences(answer)
    claims = _admission_card_claims_for_evidence(card, evidence)
    metric_claims = [claim for claim in claims if clean_text(claim.get("role")) == "metric"]
    usage_only_card = bool(claims) and all(
        clean_text(claim.get("role")) in {"identity", "usage"} for claim in claims
    )
    if not sentences or not any(clean_text(claim.get("role")) != "identity" for claim in claims):
        return False
    if not _admission_card_answer_has_natural_customer_voice(answer, card, product, locale):
        return False
    if not _admission_card_independent_claims_remain_separate(sentences, claims):
        return False
    if clean_text(card.get("intent")) == "buyer-decision" and not _admission_buyer_decision_has_source_grounded_reason(
        answer, claims, product, locale
    ):
        return False
    # A relationship metric card carries one already-validated result record,
    # including its timing, method, and study group.  The generic checker reads
    # a punctuation-separated qualification clause as an unrelated sentence, so
    # the card's own record is what validates it: the sentence reader holds
    # every published figure to the value that record selected, and the reader
    # below requires the scope that record filed to reach the shopper somewhere
    # in the answer.  No single sentence is asked to carry all of it, because
    # prose puts the caveat after the number rather than inside it.
    if metric_claims:
        if not _admission_card_answer_publishes_recorded_scope(answer, metric_claims):
            return False
    elif not _admission_metrics_are_qualified(answer, evidence, clean_text(product.get("name"))):
        return False
    # A licensed recommendation says something no record says -- that the
    # reader should consider this product -- so the clause carrying that offer
    # cannot be bound to a claim.  Which sentence, and which end of it, that
    # clause lands in is word order: a market may open on the condition
    # (``건조 피부라면 …``) or on the product, and the prompt offers both.  So
    # the exemption is read from the clause that offers rather than from a
    # position, and it is licensed once for the answer by the anchor reader,
    # which requires the customer the offer names to be one this card records.
    recommendation_licensed = bool(
        card.get("canRecommend") is True
        and _admission_faq_answer_retains_buyer_anchor(answer, evidence, card, product)
    )
    states_a_recorded_fact = False
    for sentence in sentences:
        usage_carrier = (
            _admission_usage_identity_carrier_matches_source(sentence, claims, product) if usage_only_card else None
        )
        if usage_carrier is False:
            return False
        offers = recommendation_licensed and _admission_text_offers_the_product_somewhere(sentence, product)
        coherent = (
            usage_carrier is True
            or offers
            or _admission_text_is_coherent(sentence, "action" if usage_only_card else "statement")
        )
        if not _admission_locale_is_supported(sentence, locale) or not coherent:
            return False
        if not _admission_context_is_supported(sentence, evidence) or not _admission_has_review_attribution(sentence, evidence):
            return False
        if not _admission_card_sentence_is_supported(
            sentence, claims, evidence, product, locale
        ) and not (
            recommendation_licensed
            and _admission_card_offer_sentence_is_supported(sentence, claims, evidence, card, product, locale)
        ):
            return False
        # A sentence that only calls the product by name is admitted because it
        # asserts nothing, so an answer assembled out of those alone would
        # answer nothing either.  One sentence has to state a fact the card
        # recorded for the row to be worth publishing.
        states_a_recorded_fact = states_a_recorded_fact or offers or not (
            _admission_card_sentence_only_names_the_product(sentence, claims, product)
        )
    return states_a_recorded_fact


def _admission_card_offer_sentence_is_supported(
    sentence: str,
    claims: Sequence[Mapping[str, Any]],
    evidence: Sequence[Mapping[str, Any]],
    card: Mapping[str, Any],
    product: Mapping[str, Any],
    locale: str,
) -> bool:
    """Admit the clause that offers the product, and hold the rest to the claims.

    The offer is licensed by the card rather than bound to a record, so it is
    the one clause here that no claim has to carry.  Everything else in its
    sentence is an ordinary statement and is read by the ordinary reader,
    clause by clause, against this card's own claims.  Exempting the whole
    sentence is what let a second fact ride in beside the offer -- ``…을
    추천하며, 임상 시험을 완료했습니다`` published a trial the card never
    recorded, because the offer carried the clause next to it.

    What keeps the exempt clause truthful is the conclusion reader, not the
    absence of a reader: the offer may name only a customer the anchor reader
    found in a cited record, and it may not rank the product, call it safe,
    call it a fit its card never states, draw a cause the card keeps apart, or
    publish a figure no record filed.
    """

    clauses = split_into_clauses(sentence)
    offers = [_admission_sentence_offers_the_product(clause, product) for clause in clauses]
    if not any(offers):
        return False
    return all(
        (offered and not _admission_offer_concludes_more_than_its_card(clause, card, product))
        or _admission_card_sentence_is_supported(clause, claims, evidence, product, locale)
        for clause, offered in zip(clauses, offers, strict=True)
    )


def _admission_card_answer_publishes_recorded_scope(
    answer: str, metric_claims: Sequence[Mapping[str, Any]]
) -> bool:
    """Require an answer that publishes a measurement to publish its scope too.

    A figure without the group it was measured on, the period it ran for, or
    the caveat it carries is not a result a shopper can read, and it is the
    record -- not the answer's choice of sentence -- that says which of those
    exist.  So every slot the record filled has to be filled somewhere in the
    answer, and the same slot reader decides both sides, which is what makes
    "the answer qualifies what it published" checkable rather than asserted.
    A card whose answer states no figure from a metric record it carries is
    asked for nothing: a buyer-decision card travels with the measurement the
    shopper reads beside it, and an answer that never publishes it owes no
    qualification.
    """

    stated = _admission_metric_scope_slots(answer)
    return all(
        _admission_card_metric_scope_slots(claim) <= stated
        for claim in metric_claims
        if (value := clean_text(claim.get("value")))
        and _admission_card_measurement_is_present(answer, value, clean_text(claim.get("unit")))
    )


def _admission_card_independent_claims_remain_separate(
    sentences: Sequence[str], claims: Sequence[Mapping[str, Any]]
) -> bool:
    """Forbid one predicate from joining a formula atom to a benefit atom.

    A card that records an ingredient and a benefit independently records no
    relation between them, and an answer may not supply one.  What supplies it
    is a single predicate holding both sides -- ``아미노산 유래 세정 성분이 일상
    속 노폐물을 세정합니다`` -- so what is read here is the clause, because that
    is what one predicate spans.

    A sentence stating each atom in a clause of its own joins nothing:
    ``세라마이드를 담았고, 피부 장벽 개선에 도움을 줍니다`` coordinates two
    statements, a coordinating ending is not a cause, each clause is
    separately bound to its own record, and the conclusion reader refuses any
    clause that turns the pair causal.  Reading whole sentences made this rule
    the exact opposite of the reason rule beside it -- that one requires both
    atoms to survive in the answer -- so a buyer-decision answer was refused
    for merging them when written as one sentence and refused for losing one
    of them when written as two.
    """

    if any(
        clean_text(claim.get("role")) == "ingredient-effect"
        and clean_text(claim.get("relationship")) == "explicit"
        for claim in claims
    ):
        return True
    ingredients = [
        clean_text(claim.get("ingredient")) or clean_text(claim.get("text"))
        for claim in claims
        if clean_text(claim.get("role")) in {"ingredient", "formula"}
    ]
    benefits = [
        clean_text(claim.get(key)) or clean_text(claim.get("text"))
        for claim in claims
        if clean_text(claim.get("role")) in {"benefit", "effect"}
        for key in ("benefit", "effect")
    ]
    for sentence in sentences:
        for clause in split_into_clauses(sentence):
            if any(_admission_card_term_matches(clause, value) for value in ingredients) and any(
                _admission_card_term_matches(clause, value) for value in benefits
            ):
                return False
    return True


def _admission_card_sentence_is_supported(
    sentence: str,
    claims: Sequence[Mapping[str, Any]],
    evidence: Sequence[Mapping[str, Any]],
    product: Mapping[str, Any],
    locale: str,
) -> bool:
    """Bind one answer sentence to what this card records, by one of its shapes.

    A sentence is supported when it states a recorded fact and nothing else.
    Which reader decides that depends on the shape the sentence was written in
    -- a single claim restated, a measurement published, two records joined
    clause by clause, several records listed in one clause -- and the readers
    are tried in that order because the narrower one carries the stronger
    guarantee.  A sentence that names nothing but the product is admitted
    ahead of all of them: it has no term left to be a second fact.
    """

    usage_carrier = _admission_usage_identity_carrier_matches_source(sentence, claims, product)
    if usage_carrier is not None:
        return usage_carrier
    if _admission_card_sentence_only_names_the_product(sentence, claims, product):
        return True
    # Keep final-proofreader-recognized source frames when available, then use
    # the stricter card scope for natural model composition.  The clause rule
    # below still applies here: that reader asks whether a published sentence
    # rests on the ledger, which a clause pairing one record's ingredient with
    # another record's outcome does, so without it the pairing the card kept
    # apart came back in through this door.
    if sentence_evidence_has_direct_claim_support(
        sentence, evidence
    ) and _admission_card_clause_attributions_stay_in_their_records(sentence, claims, product):
        return True
    metric_claims = [claim for claim in claims if clean_text(claim.get("role")) == "metric"]
    if metric_claims and _admission_sentence_mentions_metric(sentence, claims):
        if any(_admission_card_metric_sentence_is_supported(sentence, claim, product) for claim in metric_claims):
            return True
        # Returning here left a sentence that joined its measurement to a
        # second recorded fact with no reader at all: the whole-sentence metric
        # reader charges the other clause's words as invented, and the clause
        # reader that would back each clause against its own record was never
        # reached.  The gate itself is right, though -- this is the only reader
        # that holds a published figure to the value the card *selected*, while
        # the clause readers measure a number against the whole source line,
        # which carries the sibling results of the same panel.  So the
        # fall-through stays open only while every number the sentence
        # publishes is one the selected record filed.
        if not any(
            _admission_numeric_tokens(sentence, clean_text(product.get("name")))
            <= _admission_card_metric_numbers(claim, product)
            for claim in metric_claims
        ):
            return False
    if any(
        _admission_independent_benefit_customer_voice_matches(sentence, claim, claims, product, locale)
        for claim in claims
    ):
        return True
    if any(_admission_card_sentence_matches_claim(sentence, claim, product) for claim in claims):
        return True
    # The readers below measure a sentence against the union of the row's
    # records, and a union lets a clause draw an ingredient from one record and
    # an outcome from another: ``베타인은 피부 장벽 개선을 돕습니다`` read as
    # supported against a card that records 베타인 with a different outcome and
    # that outcome with a different ingredient, and so did the same pairing with
    # the ingredient moved into an oblique.  Either way the clause states a 1:1
    # attribution only one record may state.  The readers above are unaffected:
    # each of them already measures against a single claim, and the licensed
    # independent-benefit shape is theirs.
    if not _admission_card_clause_attributions_stay_in_their_records(sentence, claims, product):
        return False
    if _admission_card_sentence_speaks_at_product_scope(sentence, claims, product):
        return True
    if _admission_card_clauses_are_each_source_backed(sentence, claims, product):
        return True
    if _admission_card_sentence_lists_recorded_facts(sentence, claims, product):
        return True
    return _admission_card_sentence_restates_a_named_relation(sentence, claims, product)


def _admission_card_sentence_only_names_the_product(
    sentence: str, claims: Sequence[Mapping[str, Any]], product: Mapping[str, Any]
) -> bool:
    """Return whether a sentence calls the product by name and states nothing else.

    A sentence with nothing to assert cannot add an assertion.  This one writes
    no word but the names the product is called by -- the ones the ledger
    recorded and the ones the card's identity claims carry -- so there is no
    term in it to be a second fact, and the conclusion reader finds no cause,
    fit, verdict, comparison, or number to draw one with.

    Only the designations are set aside, and that is the difference between
    this and every reader below.  A scaffold or a frame word is exempt there
    because the claim it frames is matched beside it; with nothing matched,
    the frame is the whole of what the sentence says, and ``효과가 있습니다``
    or ``제품을 추천합니다`` would have been admitted as a naming.

    The prompt asks an answer to open by naming what it is about, and that
    opening was dying here.  Every reader below needs a claim with content to
    match a word against, and an identity record has none -- its whole content
    is the name, which is exactly what the comparison sets aside -- which is
    why ``role == "identity"`` reports no match rather than a match.  The
    answer reader separately requires one sentence to state a recorded fact, so
    an answer cannot be assembled out of namings alone.
    """

    identity = [claim for claim in claims if clean_text(as_dict(claim).get("role")) == "identity"]
    if not identity:
        return False
    designations = _admission_card_identity_tokens(product) | {
        token for claim in identity for token in _admission_card_tokens(clean_text(as_dict(claim).get("text")))
    }
    if _admission_card_tokens(sentence) - designations:
        return False
    return not _admission_text_draws_an_unrecorded_conclusion(sentence, identity, product)


def _admission_card_designations(claims: Sequence[Mapping[str, Any]]) -> list[str]:
    """Return the names a card records: what the product is called, and its formula's."""

    names: list[str] = []
    for raw in claims:
        claim = as_dict(raw)
        role = clean_text(claim.get("role"))
        name = clean_text(claim.get("ingredient"))
        if not name and role in {"identity", "ingredient", "formula"}:
            name = clean_text(claim.get("text"))
        if name:
            names.append(name)
    return names


def _admission_card_sentence_names_claim_terms(
    sentence: str, claim: Mapping[str, Any], product: Mapping[str, Any]
) -> bool:
    """Return whether a sentence carries the terms that identify one formula claim."""

    role = clean_text(claim.get("role"))
    if role == "ingredient-effect":
        ingredient = clean_text(claim.get("ingredient"))
        outcomes = [clean_text(claim.get(key)) for key in ("benefit", "effect") if clean_text(claim.get(key))]
        return bool(
            ingredient
            and outcomes
            and _admission_card_term_matches(sentence, ingredient)
            and any(_admission_card_term_matches(sentence, outcome) for outcome in outcomes)
        )
    if role in {"ingredient", "formula"}:
        term = clean_text(claim.get("ingredient")) or clean_text(claim.get("text"))
        return bool(term and _admission_card_term_matches(sentence, term))
    return False


def _admission_card_sentence_restates_a_named_relation(
    sentence: str, claims: Sequence[Mapping[str, Any]], product: Mapping[str, Any]
) -> bool:
    """Back a formula sentence that words one recorded relation in the card's own words.

    ``improve the visible look of fine lines`` and ``visibly firms skin`` state
    what the card records (``improve visible fine lines``, ``visibly firms``)
    using a word the card's other evidence already carries -- the hedge
    ``look``, the substrate ``skin`` the source left implicit.  Neither is a
    fact the card lacks, and holding the sentence to one claim's exact wording
    rejects the source's own vocabulary for being written down elsewhere.

    The relation itself still belongs to one claim, so only a recorded
    ingredient/outcome link opens this path: there the outcome is checked
    against the same claim that names the ingredient, and a sentence cannot
    take an ingredient from one record and an outcome from another.  A bare
    ingredient claim records no outcome to check, so a sentence pairing it with
    some benefit the card keeps separate stays on the strict test -- that pairing
    is the merge, not a wording difference.

    Naming a second record's item is not a wording difference either.  It is a
    list, and the listing reader judges a list by requiring every item to carry
    the shared predicate; letting the card's whole vocabulary stand in for one
    relation instead is what let ``베타인과 판테놀은 피부 장벽 개선을 돕습니다``
    move an improvement onto a record that never states one.
    """

    if not any(
        clean_text(claim.get("role")) == "ingredient-effect"
        and _admission_card_sentence_names_claim_terms(sentence, claim, product)
        for claim in claims
    ):
        return False
    tokens = _admission_card_content_tokens(sentence, product) - _ADMISSION_CARD_CLAIM_FRAME_TOKENS
    if len(_admission_card_named_items(tokens, claims, product)) > 1:
        return False
    card_tokens = {
        token
        for claim in claims
        if clean_text(claim.get("role")) != "identity"
        for token in _admission_card_claim_content_tokens(claim, product)
    }
    return bool(tokens and card_tokens and tokens <= card_tokens)


def _admission_card_clauses_are_each_source_backed(
    sentence: str, claims: Sequence[Mapping[str, Any]], product: Mapping[str, Any]
) -> bool:
    """Back a joined sentence one clause at a time, each by a claim of its own.

    A model writes one sentence per thought, and both markets join two
    separately recorded facts with a connective (``판테놀은 …하고, 베타인은 …``,
    ``X supports the barrier; Y improves hydration``).  Neither claim states the
    other's clause, so requiring the whole sentence to sit inside one claim
    rejects the join itself rather than any unsupported word in it.

    The unit that has to be backed is therefore the clause, and each clause is
    measured against a claim's whole record rather than against the line it was
    cut from.  A recombination -- one predicate whose parts are drawn from two
    claims -- is still a single clause and is still rejected here, and the
    sentence as a whole may still conclude no more than the claims backing it
    do, so joining two records cannot draw a cause or a verdict between them.
    A clause that asserts nothing of its own carries no content token and needs
    no source.
    """

    clauses = split_into_clauses(sentence)
    cited = [claim for claim in claims if clean_text(claim.get("role")) != "identity"]
    if len(clauses) < 2 or not cited:
        return False
    records = [_admission_card_claim_content_tokens(claim, product) for claim in cited]
    for clause in clauses:
        tokens = _admission_card_content_tokens(clause, product) - _ADMISSION_CARD_CLAIM_FRAME_TOKENS
        if not tokens:
            continue
        if not any(tokens <= record for record in records):
            return False
    return not _admission_text_draws_an_unrecorded_conclusion(sentence, cited, product)


# What a product-scope sentence puts in front of the outcome.  Korean marks the
# subject on the noun, English puts it at the head or inside a containment
# phrase, and both say the same thing: the sentence is about the product, so
# the outcome is predicated of the product and not of any one ingredient.
_ADMISSION_KOREAN_SUBJECT_PARTICLE = re.compile(r"(?:은|는|이|가)(?=\s)")


# A coordinator before a phrase makes it the second item of one argument rather
# than an argument of its own, and a list predicates of every item on it, so
# nothing there is attributed to this item alone.
_ADMISSION_COORDINATED_LEAD = re.compile(r"(?:과|와|,|\band)\s*$", re.IGNORECASE)


def _admission_owner_names(product: Mapping[str, Any]) -> list[str]:
    """Return the spellings a containment phrase may name this product's owner with.

    This is a wider list than the surfaces copy publishes the product under: an
    owner phrase is prose rather than a published name, so it calls the product
    by the brand as readily as by the title, and it may repeat the pack size the
    record carries.  The reader it is handed to derives the published spelling
    from each of these itself.
    """

    return list(
        dict.fromkeys(
            value for key in ("name", "originalName", "brand") if (value := clean_text(product.get(key)))
        )
    )


def _admission_clause_first_argument_is(clause: str, phrase: str, product: Mapping[str, Any]) -> bool:
    """Return whether a clause predicates what it states of this phrase.

    The containment phrase comes off first.  It names the product the part
    belongs to -- ``{product}에 담긴 {ingredient}은 …``, ``In {product},
    {ingredient} …``, which is the form the FAQ prompt asks for -- so it fills
    no argument slot of the clause's own predicate.  Reading the clause with it
    still in front was the whole defect: the ingredient then never stood at
    offset zero, so the reader that holds an ingredient's outcome to that
    ingredient's record never ran on a single live sentence, while the product
    sitting in front of the containment word read as the subject of a sentence
    that is about the part.

    What is left is read the way each market marks its first argument.  Korean
    marks it on the noun, so the phrase is the first argument when a topic or
    nominative particle closes it and nothing before it is argument-marked;
    English orders it instead, so the phrase is the first argument when it opens
    the clause and a predicate follows.  Both stages read this one definition,
    and the product and an ingredient are asked the same question by it.
    """

    text = clause_without_containment_owner(clean_text(clause), _admission_owner_names(product))
    match = re.search(re.escape(phrase), text, re.IGNORECASE)
    if match is None:
        return False
    head, tail = text[: match.start()], text[match.end() :]
    if _ADMISSION_COORDINATED_LEAD.search(head):
        return False
    if _ADMISSION_KOREAN_SUBJECT_PARTICLE.match(tail) is not None:
        return _ADMISSION_KOREAN_COMPETING_ARGUMENT.search(head) is None
    return not head.strip() and re.match(r"^\s+[a-z]", tail) is not None


def _admission_card_subject_ingredient_claim(
    sentence: str, claims: Sequence[Mapping[str, Any]], product: Mapping[str, Any]
) -> Mapping[str, Any] | None:
    """Return the claim whose ingredient stands as this sentence's subject.

    A sentence about an ingredient predicates its outcome of that ingredient.
    Only a claim that records that ingredient may then say what follows, so the
    claim is returned for the caller to measure the sentence against.  When the
    product fills the slot the sentence is about the product, and ``None`` sends
    it to the product-scope reader instead.
    """

    if not clean_text(sentence) or _admission_card_sentence_subject_is_the_product(sentence, product):
        return None
    for claim in claims:
        # Only a card that recorded the pairing can be contradicted by another
        # one.  An ``ingredient-effect`` claim says which outcome this
        # ingredient has, so a clause giving it a different outcome states a
        # pairing the source denied.  A card holding the ingredient and the
        # outcome as independent records pairs nothing, and the licensed
        # independent-benefit reader governs that shape instead -- charging it
        # here would reject the only sentence that shape can be written as.
        if clean_text(claim.get("role")) != "ingredient-effect":
            continue
        ingredient = clean_text(claim.get("ingredient"))
        if ingredient and _admission_clause_first_argument_is(sentence, ingredient, product):
            return claim
    return None


def _admission_card_clause_attributions_stay_in_their_records(
    sentence: str, claims: Sequence[Mapping[str, Any]], product: Mapping[str, Any]
) -> bool:
    """Return whether each clause naming an ingredient says only what its record says.

    A card that pairs an ingredient with an outcome has said which outcome that
    ingredient has, so a clause that gives it a different one states a pairing
    the source denied.  The unit is the clause and not the sentence: both
    markets join two separately recorded attributions with a connective
    (``판테놀은 …하고, 베타인은 …``), and each half stands on its own record.

    Two things are asked of a clause, because an attribution survives being
    moved out of the subject slot.  A clause whose *subject* is an ingredient
    predicates everything that follows of it, so it may say only what that one
    record says.  And wherever else the clause puts an ingredient -- an oblique
    ``with Niacinamide``, a means, a containment -- the outcome beside it is
    still read as that ingredient's, so no word that tells another pairing
    apart from this one may stand in the same clause.  Measured: the union test
    that used to stand here admitted ``… Serum helps improve skin firmness with
    Niacinamide`` against a card recording firmness for a different ingredient,
    and rejected only the bare 1:1 sentence.

    The pairings the clause itself names are read together, which is what keeps
    a product-scope list intact: ``{product}은 A와 B를 담아 …를 돕습니다`` names
    both records and attributes the outcome to the product, so neither record
    is the odd one out.  A record that pairs nothing -- an ingredient, a
    benefit, an audience filed on its own -- states no attribution to move, and
    the readers below govern those shapes.
    """

    pairings = [
        claim
        for claim in claims
        if clean_text(claim.get("role")) == "ingredient-effect" and clean_text(claim.get("ingredient"))
    ]
    names = _admission_owner_names(product)
    for raw in split_into_clauses(sentence) or [clean_text(sentence)]:
        # Words are counted on the clause without its containment phrase, which
        # is where the subject is read from too.  That phrase says the product
        # holds the part -- the very thing the card records -- so charging its
        # back-pointing determiner (``같은 제품에 담긴``, ``in the same serum``)
        # made a clause that restated its own record exactly look as though it
        # stated a word no record carried.
        clause = clause_without_containment_owner(clean_text(raw), names)
        tokens = _admission_card_content_tokens(clause, product) - _ADMISSION_CARD_CLAIM_FRAME_TOKENS
        if not tokens:
            continue
        subject = _admission_card_subject_ingredient_claim(clause, claims, product)
        if subject is not None and not tokens <= _admission_card_claim_content_tokens(subject, product):
            return False
        named = {
            index
            for index, claim in enumerate(pairings)
            if _admission_card_claim_ingredient_tokens(claim, product) <= tokens
        }
        if not named:
            continue
        stated = {
            token
            for index in named
            for token in _admission_card_claim_content_tokens(pairings[index], product)
        }
        elsewhere = {
            token
            for index, claim in enumerate(pairings)
            if index not in named
            for token in _admission_card_claim_content_tokens(claim, product)
        }
        if (tokens & elsewhere) - stated:
            return False
    return True


def _admission_card_claim_ingredient_tokens(claim: Mapping[str, Any], product: Mapping[str, Any]) -> set[str]:
    """Return the words that name one claim's ingredient, as a clause would write them.

    A clause names the ingredient when it writes every one of them.  Asking for
    a partial overlap instead let a clause "name" an ingredient it never
    mentioned, because the product's own title supplies a word of it -- the
    ``Ginseng`` of ``Ginseng Peptide`` stands in ``Concentrated Botanical
    Rejuvenating Serum`` -- which is also why the title's words come off both
    sides here.
    """

    return _admission_card_content_tokens(clean_text(claim.get("ingredient")), product)


def _admission_card_sentence_speaks_at_product_scope(
    sentence: str, claims: Sequence[Mapping[str, Any]], product: Mapping[str, Any]
) -> bool:
    """Back a sentence that says what the product, holding these, does.

    A page records an ingredient and an outcome as facts about one product.  A
    sentence may therefore say ``{product}, which holds A and B, helps C``
    without claiming that A causes C: the subject of the outcome is the
    product, and containing A and having C are two things the card records of
    it.  Requiring each clause to sit inside *one* record rejected that shape,
    which is the one a recommendation naturally completes in -- and the shape
    the source itself is written in, since a PDP lists a formula and a benefit
    under the same product.

    What is relaxed is only *which* record each word comes from; nothing is
    added.  Every word still has to be one some cited claim records, and the
    conclusion reader still refuses a cause, a fit, a verdict, a comparison,
    and a number no record filed.  So an outcome the card never recorded is
    still refused however the sentence is framed, and the attribution gate has
    already run: a clause naming one paired ingredient reaches here only when
    it says nothing that tells another pairing apart from that one, so the
    union this reader takes can no longer supply a 1:1 attribution.
    """

    cited = [claim for claim in claims if clean_text(claim.get("role")) != "identity"]
    if not cited or not _admission_card_sentence_subject_is_the_product(sentence, product):
        return False
    recorded: set[str] = set()
    for claim in cited:
        recorded |= _admission_card_claim_content_tokens(claim, product)
    tokens = _admission_card_content_tokens(sentence, product) - _ADMISSION_CARD_CLAIM_FRAME_TOKENS
    if not tokens or not tokens <= recorded:
        return False
    return not _admission_text_draws_an_unrecorded_conclusion(sentence, cited, product)


def _admission_card_sentence_subject_is_the_product(sentence: str, product: Mapping[str, Any]) -> bool:
    """Return whether the product, not one of its parts, is what the sentence is about.

    The product is the subject when it fills the sentence's first argument slot,
    which is the one question the reader above answers -- for the product and
    for an ingredient alike, so the two can never both be read as the subject of
    one clause.  A product named inside the containment phrase is not in that
    slot: there it names who holds the part the sentence is about, and reading
    it as the subject handed a sentence about an ingredient to the product-scope
    reader, which measures against every record the card holds.
    """

    return bool(clean_text(sentence)) and any(
        _admission_clause_first_argument_is(sentence, surface, product)
        for surface in _admission_product_name_surfaces(product)
        if surface
    )


def _admission_card_sentence_lists_recorded_facts(
    sentence: str, claims: Sequence[Mapping[str, Any]], product: Mapping[str, Any]
) -> bool:
    """Back one clause that lists facts the card records one per claim.

    A card keeps each fact in a claim of its own, and both markets list several
    of them inside a single clause: ``제품에는 판테놀과 베타인이 함유되어
    있습니다``, ``피부과 테스트와 인체 안자극 테스트를 완료한 제품입니다``,
    ``contains Panthenol and Betaine``.  No claim states another claim's item,
    so holding such a clause to one claim rejects the listing itself rather
    than anything it asserts -- and a list is not a join, so the clause reader
    above never sees it either.

    Listing says nothing about how the items relate.  It does say the rest of
    the clause about every item on the list, though, which is the whole risk
    here: ``완료한`` is asserted of both tests, and a shared predicate reaches
    leftward to an item whose own record may not carry it.  So each item must
    carry the entire clause, minus its siblings' items, inside one record.
    ``베타인과 판테놀은 피부 장벽 개선을 돕습니다`` then asks the betaine record
    for an improvement it never states and is rejected, while the same shape
    over two records that each state the shared part is admitted.

    A list is a list of like things, so the items must be claims of one role.
    That is what keeps an independently recorded ingredient from being listed
    with an independently recorded benefit, which is a causal merge wearing a
    list's grammar rather than a list.
    """

    cited: list[Mapping[str, Any]] = []
    for clause in split_into_clauses(sentence):
        tokens = _admission_card_content_tokens(clause, product) - _ADMISSION_CARD_CLAIM_FRAME_TOKENS
        if not tokens:
            continue
        items = _admission_card_named_items(tokens, claims, product)
        if len(items) < 2 or len({clean_text(claim.get("role")) for claim, _ in items}) != 1:
            return False
        for claim, item in items:
            siblings = {token for _, other in items for token in other} - item
            if not (tokens - siblings) <= _admission_card_claim_content_tokens(claim, product):
                return False
        cited.extend(claim for claim, _ in items if claim not in cited)
    return bool(cited) and not _admission_text_draws_an_unrecorded_conclusion(sentence, cited, product)


def _admission_card_named_items(
    tokens: set[str], claims: Sequence[Mapping[str, Any]], product: Mapping[str, Any]
) -> list[tuple[Mapping[str, Any], set[str]]]:
    """Return every claim whose own item a text names, with that item's words.

    A claim's item is the term that identifies it -- the ingredient a formula
    claim names, otherwise the atom the claim records.  How many items a text
    names is what tells a list from a single statement, so both readers ask it
    here rather than each deciding for itself what counts as naming a claim.
    """

    named: list[tuple[Mapping[str, Any], set[str]]] = []
    for claim in claims:
        if clean_text(claim.get("role")) == "identity":
            continue
        term = clean_text(claim.get("ingredient")) or clean_text(claim.get("text"))
        item = _admission_card_content_tokens(term, product) - _ADMISSION_CARD_CLAIM_FRAME_TOKENS
        if item and item <= tokens:
            named.append((claim, item))
    return named


def _admission_card_sentence_or_clause_matches_claim(
    sentence: str, claim: Mapping[str, Any], product: Mapping[str, Any]
) -> bool:
    """Return whether the sentence retains this claim, in whole or in one clause."""

    if _admission_card_sentence_matches_claim(sentence, claim, product):
        return True
    clauses = split_into_clauses(sentence)
    return len(clauses) > 1 and any(
        _admission_card_sentence_matches_claim(clause, claim, product) for clause in clauses
    )


def _admission_usage_identity_carrier_matches_source(
    sentence: str,
    claims: Sequence[Mapping[str, Any]],
    product: Mapping[str, Any],
) -> bool | None:
    """Match one English ``apply``/``use`` instruction after identity insertion.

    A model may make a source instruction citation-ready by naming the brand
    and product, or by using the equivalent leading verb ``use`` for ``apply``.
    This is deliberately not a paraphrase path: once identity and that one
    leading verb are normalized, every remaining action, order, timing, and
    frequency token must be identical to one cited usage source record.
    ``None`` leaves non-English and non-apply/use usage records on the normal
    exact source-support path.
    """

    usage_sources = [
        clean_text(claim.get("text"))
        for claim in claims
        if clean_text(claim.get("role")) == "usage" and clean_text(claim.get("text"))
    ]
    source_keys = [
        key
        for source in usage_sources
        if (key := _admission_usage_identity_carrier_key(source, product))
    ]
    if not source_keys:
        return None
    if not _admission_answer_has_brand_and_product_identity(sentence, product):
        return False
    rendered_key = _admission_usage_identity_carrier_key(sentence, product)
    return bool(rendered_key and rendered_key in source_keys)


def _admission_usage_identity_carrier_key(value: str, product: Mapping[str, Any]) -> str:
    """Return a narrow source-detail key for a controlled English usage carrier.

    The default key is exact after product identity and the leading
    ``apply``/``use`` carrier are normalized.  English source copy sometimes
    places two independently explicit modifiers in the less natural order
    ``as the first step ... immediately after cleansing``.  A named public
    instruction may put the timing first without changing the action or either
    relation.  The helper canonicalizes *only* that complete pair of literal
    modifier clauses; any other word, action, frequency, or before/after
    relation remains part of the exact residual key.
    """

    rendered = clean_text(value)
    if not re.match(r"^(?:apply|use)\b", rendered, re.IGNORECASE):
        return ""
    for identity in sorted(
        {
            clean_text(product.get(key))
            for key in ("name", "originalName", "brand")
            if clean_text(product.get(key))
        },
        key=len,
        reverse=True,
    ):
        rendered = re.sub(rf"{re.escape(identity)}(?:['’]s)?", " ", rendered, flags=re.IGNORECASE)
    rendered = re.sub(r"^(?:apply|use)\b", "apply", rendered, count=1, flags=re.IGNORECASE)
    reordered = _admission_usage_timing_and_routine_key(rendered)
    return reordered or f"exact:{_admission_normalize(rendered)}"


_ADMISSION_USAGE_ROUTINE_ROLE = re.compile(
    r"\bas\s+(?:the\s+)?(?:first|second|third|last)\s+step"
    r"(?:\s+of\s+(?:your|the)\s+[a-z]+(?:\s+[a-z]+){0,2}?)?"
    r"(?=\s+(?:(?:immediately\s+)?(?:before|after))\b|[.!?]?\s*$)",
    re.IGNORECASE,
)
_ADMISSION_USAGE_TIMING = re.compile(
    r"\b(?:immediately\s+)?(?:before|after)\s+[a-z]+(?:\s+[a-z]+){0,3}?"
    r"(?=\s+as\s+(?:the\s+)?(?:first|second|third|last)\s+step\b|[.!?]?\s*$)",
    re.IGNORECASE,
)


def _admission_usage_timing_and_routine_key(value: str) -> str:
    """Canonicalize one exact English timing/routine pair, never free prose.

    This intentionally requires both clauses and removes them by their exact
    source spans.  It is therefore narrower than token-set matching: a changed
    action, added frequency, changed temporal relation, or added step remains
    in the residual and cannot bind to the source key.
    """

    detail = clean_text(value)
    routine = _ADMISSION_USAGE_ROUTINE_ROLE.search(detail)
    timing = _ADMISSION_USAGE_TIMING.search(detail)
    if routine is None or timing is None:
        return ""
    spans = sorted((routine.span(), timing.span()), reverse=True)
    residual = detail
    for start, end in spans:
        residual = f"{residual[:start]} {residual[end:]}"
    residual_key = _admission_normalize(residual)
    clauses = sorted((_admission_normalize(routine.group()), _admission_normalize(timing.group())))
    return f"usage-modifiers:{residual_key}:{':'.join(clauses)}"


def _admission_sentence_mentions_metric(sentence: str, claims: Sequence[Mapping[str, Any]]) -> bool:
    """Return whether a sentence talks about a measurement rather than about a name.

    Publishing a measurement means publishing its number, so that is what marks
    a sentence as one.  Sharing a word with a recorded result does not: once a
    buyer-decision card carries the metric the shopper reads beside it, every
    benefit sentence overlapped some metric's outcome wording and was sent to
    the metric validator, which rejected it for naming no study group.

    A designation carries digits of its own -- ``500-Hour Aged Ginseng``,
    ``BarrierCare365`` -- so the names the card records are masked first and only
    a number the sentence measures with is read as one.
    """

    masked = sentence
    for name in sorted(_admission_card_designations(claims), key=len, reverse=True):
        masked = re.sub(re.escape(name), " ", masked, flags=re.IGNORECASE)
    numbers = _admission_numeric_tokens(masked, "")
    if not numbers:
        return False
    # A number the card records outside its metric claims belongs to that
    # claim's own fact -- the ``B5`` of ``비타민 B5``, the ``500`` of a
    # ``500-Hour`` extract -- not to a measurement the answer publishes.
    recorded = {
        token
        for raw in claims
        if clean_text(as_dict(raw).get("role")) != "metric"
        for token in _admission_numeric_tokens(clean_text(as_dict(raw).get("text")), "")
    }
    return bool(numbers - recorded)


def _admission_card_metric_sentence_is_supported(
    sentence: str, claim: Mapping[str, Any], product: Mapping[str, Any]
) -> bool:
    """Admit one sentence that publishes this record's measurement and no more.

    A measured record is a row -- the value with its unit, the outcome it
    measured, and the scope it was measured under -- and what a sentence may do
    with that row is state it.  Each reader below asks the row the same
    question it asks the sentence: the value has to be the one the row
    selected, every number has to be a number the row filed, every study slot
    the sentence asserts has to be a slot the row filled, and every word has to
    be a word the row wrote.

    Requiring the sentence to *repeat* each recorded field is what this
    replaces.  A row files its group and its caveat in fields of their own, and
    prose spreads them over the answer -- the number in one sentence, the
    caveat in the next -- so demanding all of them per sentence rejected the
    natural composition rather than any unsupported word in it; the answer
    reader separately requires the recorded scope to be published somewhere in
    the answer, which is where a shopper reads it.  What a sentence may not do
    is distort the row: a group, a period, or a method the row never filed is a
    study the page never ran, and the residual reader keeps the sentence's
    words to the row's own words, so an invented cohort is charged as the
    phrase it is.
    """

    source = clean_text(claim.get("text"))
    value, unit = clean_text(claim.get("value")), clean_text(claim.get("unit"))
    if not source or not value or not _admission_card_measurement_is_present(sentence, value, unit):
        return False
    # The numbers an answer may carry are the ones the record filed -- the
    # selected value with its unit, and the timing, method, group, and caveat
    # around it.  Reading them off ``text`` instead demanded that the source
    # line repeat every field, so a result whose study group lived only in
    # ``sample`` could not be published with its group named at all.
    sentence_numbers = _admission_numeric_tokens(sentence, clean_text(product.get("name")))
    if not sentence_numbers or not sentence_numbers <= _admission_card_metric_numbers(claim, product):
        return False
    asserted = _admission_metric_scope_slots(sentence) & _ADMISSION_METRIC_ASSERTED_SCOPE_SLOTS
    if not asserted <= _admission_card_metric_scope_slots(claim):
        return False
    return _admission_card_sentence_adds_no_unstated_claim(sentence, claim, product, metric=True)


# The scope slots that assert something about the study, as against the one
# that withdraws it.  A group, a period, or a method the record never filed is
# a study the page never ran, so a sentence may state none of them; a caveat
# takes certainty away from the figure rather than adding a study to it, which
# is the one thing an answer may qualify a record with of its own.  The answer
# reader still requires a recorded caveat to be published, because withholding
# one is what would mislead.
_ADMISSION_METRIC_ASSERTED_SCOPE_SLOTS = frozenset({"sample", "period", "method"})


def _admission_metric_scope_slots(text: str) -> frozenset[str]:
    """Return which slots of a study scope a text states, read by the contract.

    What qualifies a measurement is not a list of words but a set of slots --
    the group it was measured on, the period it ran for, the method it was read
    by, the caveat it carries -- and the measured-result contract is where each
    of those is defined, for every market at once.  Both sides of every
    comparison below are read through it, so a scope cannot be recognized in a
    record and missed in the answer restating it, and neither side is left to a
    locale of its own.
    """

    rendered = clean_text(text)
    slots = set(read_reported_study_scope(rendered) or ())
    if states_study_method(rendered):
        slots.add("method")
    return frozenset(slots)


def _admission_card_metric_scope_slots(claim: Mapping[str, Any]) -> frozenset[str]:
    """Return the study scope one metric record filed, across every field it filed in.

    A row splits its scope over ``sample``, ``timing``, ``method``, and
    ``caveat`` and repeats none of them in the source line it was cut from, so
    the slots have to be read off the whole record.  Reading the line alone is
    what made the recorded group unpublishable: the group was required of the
    sentence and then, being absent from that one line, charged against it.
    """

    return _admission_metric_scope_slots(
        " ".join(value for field in CARD_CLAIM_CONTENT_FIELDS if (value := clean_text(claim.get(field))))
    )


def _admission_card_metric_numbers(claim: Mapping[str, Any], product: Mapping[str, Any]) -> set[str]:
    """Keep a metric answer to the selected result rather than a sibling result.

    A source sentence may contain several percentages.  The selected card claim
    names one value plus its own timing, method, group, and caveat; numbers in
    a customer-facing sentence must come from those recorded fields, not from
    another result that happened to share the same source record.
    """

    value, unit = clean_text(claim.get("value")), clean_text(claim.get("unit"))
    measurement = value if not unit or value.casefold().endswith(unit.casefold()) else f"{value}{unit}"
    return _admission_numeric_tokens(
        " ".join(
            [measurement, *(clean_text(claim.get(key)) for key in ("timing", "method", "sample", "caveat"))]
        ),
        clean_text(product.get("name")),
    )


def _admission_card_measurement_is_present(sentence: str, value: str, unit: str) -> bool:
    numeric = value[: -len(unit)] if unit and value.casefold().endswith(unit.casefold()) else value
    if not numeric:
        return False
    unit_pattern = r"[%％]" if unit in {"%", "％"} else re.escape(unit)
    suffix = unit_pattern if unit else r"(?:%|％|\b)"
    return re.search(rf"(?<![\w.,]){re.escape(numeric)}\s*{suffix}(?!\d|[.,]\d)", sentence, re.IGNORECASE) is not None


def _admission_independent_benefit_customer_voice_matches(
    sentence: str,
    claim: Mapping[str, Any],
    claims: Sequence[Mapping[str, Any]],
    product: Mapping[str, Any],
    locale: str,
) -> bool:
    """Allow one explicit independent benefit atom in a neutral product carrier.

    Relationship cards deliberately keep an independently listed ingredient and
    benefit separate.  A customer-facing answer may still say ``The serum
    supports radiance`` after naming the ingredient in a previous sentence,
    but only when the selected benefit record is one atomic fact.  This is not
    a paraphrase path: causal, fit, recommendation, metric, or
    ingredient-bearing sentences continue through the ordinary strict checks.
    """

    role = clean_text(claim.get("role"))
    source = clean_text(claim.get("text"))
    if (
        role not in {"benefit", "effect"}
        or clean_text(claim.get("relationship")) != "independent"
        or not _admission_records_an_atomic_fact(source)
        or _admission_numeric_tokens(source, clean_text(product.get("name")))
        or _admission_numeric_tokens(sentence, clean_text(product.get("name")))
    ):
        return False
    if (
        _ADMISSION_CAUSAL.search(sentence) is not None
        or _ADMISSION_FAQ_RECOMMENDATION.search(sentence) is not None
        or _ADMISSION_BUYER_RECOMMENDATION_ESCALATION.search(sentence) is not None
        or _admission_independent_benefit_sentence_mentions_ingredient(sentence, claims, product)
    ):
        return False
    if locale in {"en-US", "en-GB"}:
        return _admission_independent_benefit_english_carrier_matches(sentence, source, product)
    if locale == "ko-KR":
        return _admission_independent_benefit_korean_carrier_matches(sentence, source, product)
    return False


def _admission_records_an_atomic_fact(source: str) -> bool:
    """Return whether a record states one fact with nothing joined to it.

    The carrier above quotes a benefit record into a sentence of the answer's
    own making, so what the record may be is narrow: a naming of one outcome.
    A record that asserts something already carries its own predicate and its
    own conditions (``세안 중 피부 장벽을 보호하는 저자극 포밍 클렌저입니다``),
    and restating it under another predicate drops them; a record holding two
    clauses states two facts, and quoting both under one predicate joins them.
    Neither is admitted, so the carrier adds no cause, no fit and no scope the
    record does not already have.

    Counting the record's words measured its length instead of its form:
    ``피부 진정`` was two words and refused while ``radiance`` was one and
    allowed, and nothing about either makes the other less atomic.
    """

    value = clean_text(source)
    return bool(value) and names_a_thing(value) and len(split_into_clauses(value)) == 1


def _admission_independent_benefit_sentence_mentions_ingredient(
    sentence: str, claims: Sequence[Mapping[str, Any]], product: Mapping[str, Any]
) -> bool:
    """Keep a neutral benefit carrier from joining an independent ingredient."""

    terms = [
        clean_text(candidate)
        for claim in claims
        if clean_text(claim.get("role")) in {"ingredient", "formula"}
        for candidate in (claim.get("ingredient"), claim.get("text"))
        if clean_text(candidate)
    ]
    terms.extend(
        clean_text(candidate)
        for candidate in [
            *as_list(product.get("ingredients")),
            *as_list(as_dict(product.get("semanticFacts")).get("ingredients")),
        ]
        if clean_text(candidate)
    )
    return any(_admission_card_term_matches(sentence, term) for term in terms)


def _admission_independent_benefit_english_carrier_matches(
    sentence: str, source: str, product: Mapping[str, Any]
) -> bool:
    """Match only ``The serum supports radiance``-style English prose."""

    subject = _admission_independent_benefit_subject_pattern(product, "en")
    benefit = _admission_phrase_pattern(source)
    if not subject or not benefit:
        return False
    return re.fullmatch(
        rf"{subject}\s+(?:supports?|helps?\s+support)\s+{benefit}[.!?]?",
        clean_text(sentence),
        re.IGNORECASE,
    ) is not None


def _admission_independent_benefit_korean_carrier_matches(
    sentence: str, source: str, product: Mapping[str, Any]
) -> bool:
    """Match only a direct Korean benefit-management carrier."""

    subject = _admission_independent_benefit_subject_pattern(product, "ko")
    benefit = _admission_phrase_pattern(source)
    if not subject or not benefit:
        return False
    return re.fullmatch(
        rf"{subject}(?:은|는|이|가)?\s*{benefit}(?:\s*관리)?(?:에|을|를)?\s*"
        r"(?:도움을\s*줍니다|지원합니다)[.!?。！？]?",
        clean_text(sentence),
    ) is not None


def _admission_independent_benefit_subject_pattern(product: Mapping[str, Any], language: str) -> str:
    """Build a product-only subject; no audience or suitability terms are valid."""

    name = _admission_phrase_pattern(clean_text(product.get("name")))
    brand = _admission_phrase_pattern(clean_text(product.get("brand")))
    category = _admission_phrase_pattern(clean_text(product.get("category")))
    subjects = [name] if name else []
    if brand and name:
        subjects.append(rf"{brand}(?:['’]s)?\s+{name}")
    if category:
        if language == "en":
            subjects.append(rf"(?:the|this)\s+{category}")
        else:
            subjects.append(rf"(?:이|해당)\s*{category}")
    return rf"(?:{'|'.join(subjects)})" if subjects else ""


def _admission_phrase_pattern(value: str) -> str:
    """Escape a source phrase while accepting only whitespace normalization."""

    return r"\s+".join(re.escape(part) for part in clean_text(value).split())


def _admission_card_sentence_matches_claim(
    sentence: str, claim: Mapping[str, Any], product: Mapping[str, Any]
) -> bool:
    """Return whether one sentence restates one claim, by that claim's own reader.

    What a claim requires of a sentence depends on what the claim records, so
    every role a card writes is dispatched here, and a role this reader does
    not name reports no match at all.  That is what made an evidence-result
    card unpublishable in principle: its only non-identity claim is a metric,
    the metric record had no branch, and the card fell through to the refusal
    below however faithfully its answer restated the measurement.
    """

    role = clean_text(claim.get("role"))
    source = clean_text(claim.get("text"))
    if role == "identity" or not source:
        return False
    if role == "metric":
        # A measured record is read by the measured reader: the value it
        # selected, the numbers it filed, and the study scope it filed them
        # under are each matched against the record there.
        return _admission_card_metric_sentence_is_supported(sentence, claim, product)
    if role == "ingredient-effect":
        ingredient = clean_text(claim.get("ingredient"))
        outcomes = [clean_text(claim.get(key)) for key in ("benefit", "effect") if clean_text(claim.get(key))]
        if not ingredient or not outcomes:
            return False
        if not _admission_card_term_matches(sentence, ingredient) or not any(
            _admission_card_term_matches(sentence, outcome) for outcome in outcomes
        ):
            return False
        return _admission_card_sentence_adds_no_unstated_claim(sentence, claim, product)
    if role in {"ingredient", "formula"}:
        term = clean_text(claim.get("ingredient")) or source
        return _admission_card_term_matches(sentence, term) and _admission_card_sentence_adds_no_unstated_claim(
            sentence, claim, product
        )
    if role in {"benefit", "effect", "audience", "concern", "usage", "safety"}:
        return _admission_card_sentence_adds_no_unstated_claim(sentence, claim, product)
    return False


def _admission_card_sentence_adds_no_unstated_claim(
    sentence: str, claim: Mapping[str, Any], product: Mapping[str, Any], *, metric: bool = False
) -> bool:
    """Admit a sentence that restates one claim and asserts nothing else.

    What a claim says is what its record filed, not the one line the record was
    cut from.  Reading ``text`` alone made the measured path unsatisfiable --
    the checks above require the recorded study group and method to appear in
    the sentence, while this comparison then charged those very words as
    invented -- so the claim is read from every field the card writes.

    An answer may not add an assertion, and an assertion reaches a sentence two
    ways.  It arrives as a word: a term the claim never states is a second fact
    (``임상 시험을 완료했습니다`` over a card that records no trial), and that is
    what the residual test below rejects.  Or it is drawn with grammar over the
    claim's own words -- a number, a cause, a fit, a safety or comparison
    verdict -- and that is what the conclusion test rejects.  Together they are
    what keeps this from being a paraphrase licence: nothing is admitted whose
    words and whose conclusions are not already in the cited record.

    A word that only marks a role is not a word here, so the grammar a prompt
    asks for -- a connective, a hedge, a re-ended predicate, the owner a
    containment frame names -- leaves no residual to explain.
    """

    content = _admission_card_claim_content_tokens(claim, product)
    tokens = _admission_card_content_tokens(sentence, product) - _ADMISSION_CARD_CLAIM_FRAME_TOKENS
    if metric:
        # A filed row becomes a sentence by being attributed: the value was
        # obtained rather than asserted.  The row's selected value, its
        # numbers, and the study scope it filed them under are each matched
        # against the row by the measured reader, so that attribution adds no
        # claim -- and the class holds no outcome and no method, which are the
        # row's own fields and stay charged here.
        tokens -= _ADMISSION_METRIC_REPORTING_TOKENS
    if not tokens or not content or tokens - content:
        return False
    return not _admission_text_draws_an_unrecorded_conclusion(sentence, [claim], product)


def _admission_text_draws_an_unrecorded_conclusion(
    text: str, claims: Sequence[Mapping[str, Any]], product: Mapping[str, Any]
) -> bool:
    """Return whether a text concludes something none of its claims concludes.

    Holding an answer to the words of its claims does not hold it to their
    statements: the same words rearranged can measure, explain, qualify a
    customer, or rank a product where the record only listed.  Those are the
    conclusions a shopper acts on, so each is required on both sides -- a
    cause, a customer fit, a safety or superiority verdict, a comparison, and
    every number -- and the same reader decides each side, which is what makes
    "the answer concludes no more than its record" checkable rather than
    asserted.  Anything the record itself concludes the answer may restate; the
    residual test separately keeps it to the record's own words.
    """

    recorded = " ".join(
        value for claim in claims for field in CARD_CLAIM_CONTENT_FIELDS if (value := clean_text(claim.get(field)))
    )
    if not recorded:
        return True
    patterns = [_ADMISSION_COMPARISON, _ADMISSION_BUYER_FIT_VERDICT, _ADMISSION_BUYER_RECOMMENDATION_ESCALATION]
    if len(claims) > 1:
        # A connective inside one record explains that record's own fact, and
        # the reason a recommendation gives is a reason to buy rather than a
        # mechanism, so rejecting it would reject the grammar the prompt asks
        # for.  Between two records there is no relation to explain, and the
        # connective would be the whole of the new claim, so that is where the
        # causal frame has to be recorded on both sides.
        patterns.append(_ADMISSION_CAUSAL)
    for pattern in patterns:
        if pattern.search(text) is not None and pattern.search(recorded) is None:
            return True
    name = clean_text(product.get("name"))
    return bool(_admission_numeric_tokens(text, name) - _admission_numeric_tokens(recorded, name))


def _admission_card_term_matches(sentence: str, term: str) -> bool:
    expected = _admission_card_content_tokens(term, {})
    actual = _admission_card_content_tokens(sentence, {})
    if not expected or not actual:
        return False
    required = 1 if len(expected) == 1 else min(2, len(expected))
    return len(expected & actual) >= required


def _admission_card_content_tokens(value: str, product: Mapping[str, Any]) -> set[str]:
    return _admission_card_tokens(value) - _admission_card_identity_tokens(product) - _ADMISSION_CARD_SCAFFOLD_TOKENS


def _admission_card_identity_tokens(product: Mapping[str, Any]) -> set[str]:
    """Return the words that call the product rather than say anything about it."""

    return _admission_card_tokens(
        " ".join(
            clean_text(product.get(key)) for key in ("name", "originalName", "brand") if clean_text(product.get(key))
        )
    )


def _admission_card_claim_content_tokens(claim: Mapping[str, Any], product: Mapping[str, Any]) -> set[str]:
    """Return every word one card claim records, from every field it records in.

    A claim is a record: the ingredient, the outcome, the measured value and
    the conditions it was measured under each have a field, and ``text`` is
    only the source line they were cut from.  Counting ``text`` alone counted a
    recorded field as an invented phrase, which is why a measured answer could
    not be written at all -- the method and study group were demanded of the
    sentence and then charged against it.  Reading the field list the card
    builder writes is not a new fact; it is the record, read whole.
    """

    return _admission_card_content_tokens(
        " ".join(value for field in CARD_CLAIM_CONTENT_FIELDS if (value := clean_text(claim.get(field)))),
        product,
    )


def _admission_card_tokens(value: str) -> set[str]:
    """Count the distinct words a text states, keeping the numbers metric groups need.

    Each market spells the same word differently wherever it stands.  Korean
    marks a word's role on the word, so a source phrase (``세정``,
    ``클렌징폼``) and the sentence that states it (``세정합니다``,
    ``클렌징폼은``) never share a surface form; English conjugates the base form
    a source writes (``helps improve``) into the form an answer writes
    (``improves``).  A reader that counts those as different words reports every
    natural sentence as asserting something its source never said, so both
    reductions answer the one question this comparison asks, and neither is left
    to a locale of its own.

    A word is what one run of letters spells, and a measurement is spelled with
    a symbol in the middle of it: ``97.1%를`` is the number, the unit that
    scales it, and the particle marking what the clause does with the phrase.
    The word class has no symbol in it, so it cut that phrase at the ``%`` and
    left the objective particle standing as a word of its own -- and no record
    spells a bare particle, so the orphan could be found in no claim and every
    Korean sentence that put a measurement where a clause wants an object was
    unbindable.  Words are therefore read inside the run of text they were
    written in, and a run's later word that is nothing but a particle marks the
    word before it rather than stating one.  A particle written as a word of its
    own is still read as written, which is where a locale puts a determiner.
    """

    return {
        stem
        for chunk in clean_text(value).casefold().split()
        for index, raw in enumerate(_ADMISSION_TOKEN_WORD.findall(chunk))
        if (not index or strip_korean_particle(raw)) and (stem := _admission_token_stem(raw))
    }


def _admission_question_topic(question: str) -> tuple[str, frozenset[str]] | None:
    for topic, pattern, roles in _ADMISSION_TOPIC_PATTERNS:
        if pattern.search(question):
            return topic, roles
    return None


def _admission_faq_question_requires_buyer_anchor(question: str) -> bool:
    """Identify customer-fit questions whose answer must retain its target relation.

    A field-level evidence check can prove that a question and answer each
    occur somewhere in the product record without proving that the answer
    actually answers ``Who is this for?``.  Keep this narrowly scoped to
    audience/suitability wording; formula, usage, metric, and review FAQs
    continue through their own source-support paths.
    """

    text = clean_text(question)
    if not text:
        return False
    topic = _admission_question_topic(text)
    return bool(
        (topic is not None and topic[0] == "audience")
        or _ADMISSION_ENGLISH_BUYER_QUESTION.search(text)
        or _ADMISSION_KOREAN_BUYER_QUESTION.search(text)
    )


def _admission_text_has_explicit_buyer_anchor(text: str) -> bool:
    """Require a direct source-shaped audience or concern relation in prose.

    Whom the product suits and what it does about a concern are both such
    relations, whatever wording carries them, so the shared customer-relation
    test decides the question first -- structurally for fitness, and without a
    closed list of concerns for the rest.  The market phrasings below remain as
    a floor for the sentence shapes that test does not read, such as an answer
    opening ``For dry skin, ...``.
    """

    value = clean_text(text)
    if not value:
        return False
    return bool(
        states_a_customer_relation(value)
        or _ADMISSION_ENGLISH_BUYER_ANSWER.search(value)
        or _ADMISSION_KOREAN_BUYER_ANSWER.search(value)
    )


def _admission_faq_answer_retains_buyer_anchor(
    answer: str,
    evidence: Sequence[Mapping[str, Any]],
    card: Mapping[str, Any] | None,
    product: Mapping[str, Any],
) -> bool:
    """Ensure a buyer recommendation retains its exact card-backed customer target.

    A recommendation can be written naturally in customer voice instead of
    copying a source-shaped phrase such as ``works best for``.  That fluency
    is only safe when the immutable card explicitly permits recommendation,
    the cited audience/concern relations supply every target atom the sentence
    states, and the opening recommendation adds no target, safety, or causal
    claim of its own.  Legacy rows retain the older direct-source requirement.
    """

    if card is None:
        return bool(
            _admission_text_has_explicit_buyer_anchor(answer)
            and any(
                clean_text(item.get("role")) in {"audience", "concern"}
                or _admission_text_has_explicit_buyer_anchor(clean_text(item.get("text")))
                for item in evidence
            )
        )
    if card.get("canRecommend") is not True or _ADMISSION_FAQ_SOURCE_NARRATION.search(answer) is not None:
        return False
    sentences = _admission_sentences(answer)
    if not sentences or not _admission_states_a_recommendation(sentences[0], product):
        return False
    if _admission_offer_concludes_more_than_its_card(sentences[0], card, product):
        return False
    cited_ids = {clean_text(item.get("id")) for item in evidence if clean_text(item.get("id"))}
    target_tokens = _admission_buyer_anchor_tokens(sentences[0], product)
    if not target_tokens:
        return False
    # A recommendation is written in the customer's voice, so its opening
    # sentence necessarily carries wording no source used -- that is what makes
    # it a recommendation rather than a quotation.  Subtracting that wording by
    # listing neutral words cannot be done once for every market: a list that
    # covers English leaves ``데일리``, ``선택지`` standing as if they named a
    # customer, and then no natural Korean recommendation can ever pass.
    #
    # What the sentence may not do is name a customer or a concern the card
    # never recorded, so the comparison reads the targets it states: every
    # customer it designates, and the words it shares with the card's own
    # audience and concern claims.  Both are then read against this row's own
    # cited records -- the designation against the one that licenses the
    # recommendation, the target words against all of them.
    stated_designations = [
        _admission_buyer_anchor_tokens(designation, product)
        for designation in audience_designations(sentences[0])
    ]
    card_target_tokens = {
        token
        for raw in as_list(card.get("claims"))
        if clean_text(as_dict(raw).get("role")) in {"audience", "concern"}
        for token in _admission_buyer_anchor_tokens(clean_text(as_dict(raw).get("text")), product)
    }
    recorded: list[set[str]] = []
    licensing: list[set[str]] = []
    for raw_claim in as_list(card.get("claims")):
        claim = as_dict(raw_claim)
        if clean_text(claim.get("role")) not in {"audience", "concern"}:
            continue
        if clean_text(claim.get("relationship")) != "explicit":
            continue
        source = clean_text(claim.get("text"))
        claim_ids = {clean_text(identifier) for identifier in as_list(claim.get("evidenceIds")) if clean_text(identifier)}
        # Extraction records one sentence under every path that repeats it, so a
        # claim routinely carries several ids for a single fact.  Citing the
        # fact is citing one of them; demanding all of them asks the row to
        # list duplicates it never read as separate evidence.
        if not source or not claim_ids or not claim_ids & cited_ids:
            continue
        source_tokens = _admission_buyer_anchor_tokens(source, product)
        if not source_tokens:
            continue
        recorded.append(source_tokens)
        # A formula result can be a useful supporting sentence, but it is not
        # itself permission to convert an unrelated target into a customer-fit
        # recommendation.  What licenses the recommendation must be
        # source-shaped customer evidence from this exact card; what a target
        # word has to be is merely recorded, which the whole cited set says.
        if _admission_text_has_explicit_buyer_anchor(source) or _admission_claim_states_a_product_concern(claim, card):
            licensing.append(source_tokens)
    if not licensing:
        return False
    # A customer names her own situation in one breath -- ``건조하거나 민감한
    # 피부의 장벽 관리`` -- while extraction files the skin type and the barrier
    # concern in claims of their own.  Asking one claim to hold every target
    # the sentence states therefore refused every such opening, so the target
    # words are read against the audience and concern relations this row cited,
    # together.  Naming two recorded targets side by side states no relation
    # between them, so nothing is concluded that the records do not already
    # say; the cause, fit and escalation readers above separately refuse a
    # sentence that draws one from them.
    #
    # A designation is not a target word but one customer's name, and a name
    # assembled out of two records would be a customer neither of them
    # records.  So each customer the sentence designates still has to sit
    # inside a single record, and inside one that licenses the recommendation.
    if any(
        not any(designation <= source_tokens for source_tokens in licensing)
        for designation in stated_designations
    ):
        return False
    stated_targets = target_tokens & card_target_tokens
    return bool(stated_targets and stated_targets <= set().union(*recorded))


def _admission_offer_concludes_more_than_its_card(
    text: str, card: Mapping[str, Any], product: Mapping[str, Any]
) -> bool:
    """Return whether an offer draws a conclusion the card it rests on never drew.

    An offer is licensed by the card rather than bound to one of its claims --
    that a reader should consider this product is what no record says -- so
    what it may not conclude is stated here instead of being matched word by
    word.  It may not rank the product or call it safe, it may not pair an
    ingredient with an outcome the card keeps apart from it, it may not call
    the product a fit when nothing the card records states fitness, and it may
    not publish a figure no record on the card filed.

    An offer can stand in any clause of any sentence, so this is read wherever
    it stands.  Reading it only in the first sentence is what let an unbound
    figure in: the clause exemption asks no claim to carry the offer's words,
    and a number is exactly the kind of word a shopper acts on.
    """

    if (
        _admission_recommendation_asserts_an_unstated_cause(text, card, product)
        or _ADMISSION_BUYER_RECOMMENDATION_ESCALATION.search(text) is not None
        or _admission_asserts_a_fit_the_card_never_states(text, card)
    ):
        return True
    recorded = " ".join(
        value
        for raw in as_list(card.get("claims"))
        for field in CARD_CLAIM_CONTENT_FIELDS
        if (value := clean_text(as_dict(raw).get(field)))
    )
    name = clean_text(product.get("name"))
    return bool(_admission_numeric_tokens(text, name) - _admission_numeric_tokens(recorded, name))


def _admission_recommendation_asserts_an_unstated_cause(
    sentence: str, card: Mapping[str, Any], product: Mapping[str, Any]
) -> bool:
    """Return whether a recommendation's opening draws a cause its card never records.

    A recommendation reads naturally with a connective, and the reason it gives
    is a reason to buy rather than a mechanism: ``is a recommended choice
    because it addresses the look of existing fine lines`` names the product's
    own recorded action.  So does a recorded formula relation -- the source
    itself draws that line, and a shopper asking what to buy is answered by it.
    Rejecting every connective rejected those sentences for their grammar
    rather than for anything they asserted.

    What the opening may not do is pair an ingredient with an outcome the card
    keeps apart from it.  That is the merge the independent-claims guard forbids
    in the rest of the answer, and a connective in the first sentence is how it
    would enter.  So an ingredient may stand in the cause only while the
    sentence states a relation the card records for it.
    """

    if _ADMISSION_CAUSAL.search(sentence) is None:
        return False
    claims = [as_dict(raw) for raw in as_list(card.get("claims"))]
    names_an_ingredient = any(
        name and _admission_card_term_matches(sentence, name)
        for claim in claims
        if clean_text(claim.get("role")) in {"ingredient", "formula", "ingredient-effect"}
        for name in (clean_text(claim.get("ingredient")) or clean_text(claim.get("text")),)
    )
    if not names_an_ingredient:
        return False
    return not any(
        clean_text(claim.get("role")) == "ingredient-effect"
        and clean_text(claim.get("relationship")) == "explicit"
        and _admission_card_sentence_or_clause_matches_claim(sentence, claim, product)
        for claim in claims
    )


def _admission_asserts_a_fit_the_card_never_states(sentence: str, card: Mapping[str, Any]) -> bool:
    """Return whether a recommendation calls the product a fit its card never states.

    Whether a sentence states fitness is structural -- an audience stands in
    the complement and the predicate is that audience's own clause -- so the
    suitability contract decides it, and the market wordings beside it stay as
    a floor for the shapes that reading does not reach.  Reading the wordings
    alone let the same conclusion through under any other predicate
    (``민감 피부에 잘 맞습니다``), which matters more now that a recommendation
    is recognized by the slot the product stands in rather than by its verb:
    the offer reader admits those predicates, and a card recording only what
    the product is *for* may not publish a verdict on whom it suits.
    """

    if _ADMISSION_BUYER_FIT_VERDICT.search(sentence) is None and not is_suitability_statement(sentence):
        return False
    return not any(
        is_suitability_statement(clean_text(as_dict(raw).get("text")))
        for raw in as_list(card.get("claims"))
        if clean_text(as_dict(raw).get("role")) in {"audience", "concern"}
    )


def _admission_claim_states_a_product_concern(claim: Mapping[str, Any], card: Mapping[str, Any]) -> bool:
    """Return whether a concern claim speaks for the product, not for one ingredient.

    ``A powerhouse serum that addresses the look of existing fine lines`` says
    what the product does about a customer's concern, and a recommendation may
    rest on it: the customer asking about fine lines is being answered.
    ``판테놀은 피부 장벽을 개선합니다`` says what one ingredient does, and a
    formula result is not itself permission to recommend the product to
    someone.  Both sentences report an outcome, so the verb cannot tell them
    apart -- whose sentence it is can.  The card already records which names
    are ingredients, so the subject is read against that list rather than
    against a vocabulary of predicates.
    """

    if clean_text(claim.get("role")) != "concern":
        return False
    source = clean_text(claim.get("text"))
    if not source:
        return False
    opening = _admission_normalize(source)
    for raw_claim in as_list(card.get("claims")):
        sibling = as_dict(raw_claim)
        if clean_text(sibling.get("role")) not in {"ingredient", "formula", "ingredient-effect"}:
            continue
        name = _admission_normalize(clean_text(sibling.get("ingredient")) or clean_text(sibling.get("text")))
        if name and opening.startswith(name):
            return False
    return True


def _admission_buyer_anchor_tokens(value: str, product: Mapping[str, Any]) -> set[str]:
    """Keep only target atoms, not neutral recommendation grammar or identity."""

    identity_tokens = {
        normalized
        for raw in _admission_card_tokens(
            " ".join(
                clean_text(product.get(key))
                for key in ("name", "originalName", "brand")
                if clean_text(product.get(key))
            )
        )
        if (normalized := _admission_normalize_buyer_anchor_token(raw))
    }
    return {
        normalized
        for raw in _admission_card_tokens(value)
        if (normalized := _admission_normalize_buyer_anchor_token(raw))
        and normalized not in identity_tokens
        and normalized not in _ADMISSION_BUYER_ANCHOR_CARRIER_TOKENS
        and normalized not in _ADMISSION_CARD_SCAFFOLD_TOKENS
    }


def _admission_normalize_buyer_anchor_token(token: str) -> str:
    """Normalize a Korean word to the stem a source target and its carrier share.

    An anchor is a source target read back out of prose, where it also stands in
    a conditional clause (``건조하다면``).  That ending is the anchor's own;
    everything else a Korean word carries to mark its role is reduced by the
    same rule the words it is compared against were reduced by, so only the
    clause endings are listed here and no word is measured against a stem that
    a second rule cut differently.
    """

    normalized = clean_text(token).casefold()
    if not re.search(r"[가-힣]", normalized):
        return normalized
    normalized = korean_content_stem(normalized)
    for suffix in _ADMISSION_KOREAN_ANCHOR_SUFFIXES:
        if normalized.endswith(suffix) and len(normalized) > len(suffix):
            return normalized[: -len(suffix)]
    return normalized


def _admission_question_is_product_specific(question: str, product: Mapping[str, Any]) -> bool:
    name = _admission_normalize(clean_text(product.get("name")))
    return bool(name and name in _admission_normalize(question))


def _admission_answer_has_brand_and_product_identity(answer: str, product: Mapping[str, Any]) -> bool:
    """Require citation-ready entity identity in a model-composed answer.

    Copy names the product, not the pack it is sold in: the rendered
    ``Product.name`` is the recorded title without its size or option suffix,
    and the relationship card hands the model that same surface.  Both spell the
    one entity, so requiring the recorded title verbatim would reject an answer
    for naming the product exactly as the schema publishes it.
    """

    text = _admission_normalize(answer)
    brand = _admission_normalize(clean_text(product.get("brand")))
    return bool(
        any(_admission_normalize(surface) in text for surface in _admission_product_name_surfaces(product))
        and (not brand or brand in text)
    )


def _admission_product_kinds(product: Mapping[str, Any]) -> list[str]:
    """Return the kinds of thing the page records this product as being.

    A recommendation may offer the product by its kind rather than by its
    title -- ``a suitable first-step serum`` offers as plainly as ``a suitable
    choice`` -- and the kind is what the page already records, so it is read
    from the category field or from the title that states it.
    """

    kinds = [clean_text(product.get("category")), clean_text(product_type_from_name(clean_text(product.get("name"))) or "")]
    return [kind for kind in dict.fromkeys(kinds) if kind]


def _admission_offered_surfaces(product: Mapping[str, Any]) -> list[str]:
    """Return every surface an offer can put in front of the reader.

    An offer names the product it offers, by the title the schema publishes or
    by its kind.  Every reader that looks for the offered thing reads this one
    list, so none can be left asking for a surface the page never states.
    """

    surfaces = [*_admission_product_name_surfaces(product), *_admission_product_kinds(product)]
    return [value for value in dict.fromkeys(surfaces) if value]


def _admission_speaks_of_the_reader(value: str) -> bool:
    """Return whether a text says something about the reader's own situation.

    Which market's grammar carries the situation is not what decides whether a
    reader was spoken of, and PDP copy mixes scripts constantly, so both
    markets this package publishes are read rather than the one the locale
    names -- the same convention the customer-relation reader follows.
    """

    return any(states_a_customer_situation(value, market) for market in ("ko-KR", "en-US"))


def _admission_text_carries_an_offer_wording(text: str, product: Mapping[str, Any]) -> bool:
    """Return whether a text says outright that it is offering the product.

    Two marks say it without any reader being described: the words that offer
    (``추천``, ``recommended``, ``worth considering``, ``a good choice``), and
    the determiner English puts in front of the kind being offered -- ``a
    suitable first-step serum`` offers as plainly as ``a suitable choice``.
    A card that licenses no recommendation may not carry either of them, which
    is the question this reading answers on its own.
    """

    if _ADMISSION_FAQ_RECOMMENDATION.search(text) is not None:
        return True
    return any(
        re.search(rf"\b(?:an?|the)\s+(?:[\w-]+\s+){{0,3}}{re.escape(kind)}\b", text, re.IGNORECASE) is not None
        for kind in _admission_product_kinds(product)
    )


# Korean writes a topic or case particle on the offered noun, and the predicate
# is that noun's own only while no other case-marked argument claims it:
# ``제품을 추천합니다`` offers the product, while ``제품은 판테놀을 담았습니다``
# predicates of the panthenol and offers nothing.  This is the reading the
# suitability contract already uses to find a fitness predicate, and for the
# same reason -- any predicate standing in that slot states the same relation,
# so none of them is enumerated.
_ADMISSION_KOREAN_OFFERED_ARGUMENT = re.compile(r"(?:은|는|이|가|을|를|도|만)(?![가-힣])")
_ADMISSION_KOREAN_COMPETING_ARGUMENT = re.compile(r"[가-힣](?:이|가|을|를)(?=\s)")


def _admission_names_the_product_in_an_argument_slot(text: str, product: Mapping[str, Any]) -> bool:
    """Return whether the product stands as an argument of the text's own predicate."""

    for value in _admission_offered_surfaces(product):
        for match in re.finditer(_admission_phrase_pattern(value), text, re.IGNORECASE):
            particle = _ADMISSION_KOREAN_OFFERED_ARGUMENT.match(text, match.end())
            if particle is None:
                continue
            if _ADMISSION_KOREAN_COMPETING_ARGUMENT.search(f"{text[particle.end():]} ") is None:
                return True
    return False


def _admission_sentence_offers_the_product(text: str, product: Mapping[str, Any]) -> bool:
    """Return whether a text puts this product in front of the reader as a choice.

    Offering is a relation between the product and the reader, so both have to
    stand in the text: it says something about the reader's own situation, and
    it names this product -- or the kind of thing it is -- in the slot that
    makes it the thing being offered.  Which mark fills that slot is the
    market's, and both are read here.

    Korean marks it on the word, and reading that mark is what this reader
    adds: whatever predicate closes the slot states the offer, so
    ``추천합니다``, ``잘 맞습니다``, ``알맞습니다``, ``제안드립니다`` and
    ``써 보실 만합니다`` are read alike.  Only the first of those was published
    in twelve live runs, because a closed list of offer verbs was the only
    Korean path and the category reading beside it looked for an English
    article.  English marks the slot with that article, or with the offer said
    outright, and those are the marks it was already read by, so no English
    text is judged differently here.

    Each half rules out a shape the other admits.  Without the reader's
    situation, ``저자극 포밍 클렌저입니다`` classifies the product rather than
    offering it to anyone.  Without the slot, ``세안 중 피부 장벽을 보호하는
    저자극 포밍 클렌저입니다`` has its predicate taken by the barrier and says
    what the product does, not what the reader should consider.
    """

    if not _admission_speaks_of_the_reader(text):
        return False
    if _admission_names_the_product_in_an_argument_slot(text, product):
        return True
    return _admission_text_carries_an_offer_wording(text, product) and any(
        re.search(_admission_phrase_pattern(value), text, re.IGNORECASE) is not None
        for value in _admission_offered_surfaces(product)
    )


def _admission_text_offers_the_product_somewhere(text: str, product: Mapping[str, Any]) -> bool:
    """Return whether a text offers the product, read whole or clause by clause.

    A market may put the offer in a clause of its own and spread the rest of
    the sentence around it, and the prompt asks for both orders, so both
    readings answer the one question and every caller asks it the same way.
    """

    return any(
        _admission_sentence_offers_the_product(part, product)
        for part in (text, *split_into_clauses(text))
    )


def _admission_states_a_recommendation(sentence: str, product: Mapping[str, Any]) -> bool:
    """Return whether a sentence offers the product as one of the reader's options.

    An offer is read from the slot the product stands in, by the reader above:
    the sentence says something about the reader's situation and names the
    product where its market marks the thing being offered, so any predicate
    there reads the same.  A sentence is read whole and clause by clause,
    because a market may put the offer in either and the prompt asks for both
    orders.

    The outright offer wordings stand above that reading, because this reader
    answers a second question too: whether a card that licenses no
    recommendation was given one.  Those words offer the product whether or
    not the reader was described, and a card without the licence may not carry
    them either way.
    """

    if _admission_text_carries_an_offer_wording(sentence, product):
        return True
    return _admission_text_offers_the_product_somewhere(sentence, product)


def _admission_product_name_surfaces(product: Mapping[str, Any]) -> list[str]:
    """Return the surfaces published copy may name one recorded product under.

    Copy names the product, not the pack it is sold in: the rendered
    ``Product.name`` is the recorded title without its size or option suffix,
    and the relationship card hands the model that same surface.  Every gate
    that looks for the product in an answer reads this one list, so a gate
    cannot be left behind asking for a spelling the schema no longer publishes.
    """

    title = clean_text(product.get("name"))
    return [value for value in dict.fromkeys([title, product_title_without_sku_qualifier(title)]) if value]


def _admission_has_customer_context(value: str, locale: str) -> bool:
    """Recognize a customer situation without turning it into public copy."""

    return states_a_customer_situation(value, locale)


def _admission_question_mentions_category_or_product(question: str, product: Mapping[str, Any]) -> bool:
    """Require a choice-shaped FAQ query, whether it names the SKU or its category.

    Extraction does not always record a category, and a page that leaves the
    field empty would otherwise admit no customer question at all -- not even
    one naming the very kind of thing the product is.  The title still states
    that kind, so the same inference is read over the question: a shopper
    asking which cleansing foam to choose is asking about this product's
    category whether or not the field beside it was filled in.  The category
    field stays the first authority where extraction did record one.
    """

    if _admission_question_is_product_specific(question, product):
        return True
    category_tokens = _admission_card_content_tokens(clean_text(product.get("category")), {})
    question_tokens = _admission_card_content_tokens(question, {})
    if category_tokens & question_tokens or _ADMISSION_FAQ_GENERIC_CATEGORY.search(question) is not None:
        return True
    product_type = product_type_from_name(clean_text(product.get("name")))
    return product_type is not None and product_type_from_name(question) == product_type


def _admission_question_has_customer_situation_and_choice(
    question: str, product: Mapping[str, Any], locale: str
) -> bool:
    """Keep FAQ questions in customer voice instead of analyst or source voice."""

    return bool(
        _admission_has_customer_context(question, locale)
        and _admission_question_mentions_category_or_product(question, product)
    )


def _admission_is_customer_decision_question(
    question: str, product: Mapping[str, Any], locale: str
) -> bool:
    """Admit only customer-situation questions with a product or category choice."""

    text = clean_text(question)
    lowered = text.casefold()
    if not text or not text.rstrip().endswith(("?", "？")):
        return False
    if re.search(
        r"\b(?:which|what)\s+(?:ingredients?|components?|formula|benefits?|effects?|ratings?)\b|"
        r"\bwhat\s+does\b.*\b(?:say|state|list|mention|show)\b|"
        r"\b(?:page|source)\s+(?:say|state|list|mention|show)\b|"
        r"^\s*(?:how\s+to\s+use|directions?)(?:\s+[^?]+)?\s*\??$|"
        r"\b(?:rating|ratings|stars?)\b|"
        r"^(?:어떤\s+)?(?:성분|효능|효과|평점|사용법)\s*(?:인가요|입니까|\?)?\s*$",
        lowered,
        re.IGNORECASE,
    ):
        return False
    if _ADMISSION_FAQ_ANALYST_OR_SOURCE_QUESTION.search(text) is not None:
        return False
    return _admission_question_has_customer_situation_and_choice(text, product, locale)


def _admission_answer_opens_in_customer_voice(answer: str, product: Mapping[str, Any], locale: str) -> bool:
    """Require a recommendation's opening sentence to speak of the reader.

    An answer opens in the customer's voice when its first sentence names the
    product and says something about the reader's own situation.  Where that
    situation clause sits is word order rather than truth: Korean fronts the
    condition (``건조 피부라면 …``), English trails it (``… for dry skin``), and
    the prompt itself offers to open on the product's name.  Reading only the
    text *before* the name rejected every answer that opened on it -- the
    product stood at position zero and the prefix was empty -- so the sentence
    is read whole.

    The product's own title and brand are set aside before that reading: a
    title may name a skin type itself, and a product named after its buyer is
    not an answer speaking to one.  Some source-backed audience relations
    naturally open with the named product ("Serum X works best for dry skin"),
    which the anchor reading below still recognizes.  The buyer-anchor gate
    separately requires the cited audience or concern relation, so this is the
    voice test alone and turns no bare brand mention into a recommendation.
    """

    sentences = _admission_sentences(answer)
    surfaces = _admission_product_name_surfaces(product)
    if not sentences or not surfaces:
        return False
    opening = sentences[0]
    if not any(re.search(re.escape(surface), opening, re.IGNORECASE) is not None for surface in surfaces):
        return False
    stated = opening
    for identity in [*surfaces, clean_text(product.get("brand"))]:
        if identity:
            stated = re.sub(re.escape(identity), " ", stated, flags=re.IGNORECASE)
    return bool(
        _admission_has_customer_context(stated, locale)
        or _admission_text_has_explicit_buyer_anchor(opening)
    )


def _admission_card_answer_has_natural_customer_voice(
    answer: str, card: Mapping[str, Any], product: Mapping[str, Any], locale: str
) -> bool:
    """Keep card-backed answers direct, while allowing only explicit-fit recommendations."""

    if _ADMISSION_FAQ_SOURCE_NARRATION.search(answer) is not None:
        return False
    sentences = _admission_sentences(answer)
    recommendation = bool(sentences and _admission_states_a_recommendation(sentences[0], product))
    can_recommend = card.get("canRecommend") is True
    if not can_recommend:
        return not recommendation and _ADMISSION_FAQ_RECOMMENDATION.search(answer) is None
    return bool(
        recommendation
        and _admission_answer_opens_in_customer_voice(answer, product, locale)
        and _admission_answer_has_brand_and_product_identity(answer, product)
    )


def _admission_situation_concludes_beyond_its_evidence(
    text: str, evidence: Sequence[Mapping[str, Any]], product: Mapping[str, Any]
) -> bool:
    """Return whether a stated situation decides something only a record may decide.

    A situation is the reader's own, so it is not matched against the source
    word by word.  What it may not do is settle for the reader what only a
    record settles: publish a figure no cited atom filed, draw a cause no
    cited atom draws, call the product a fit when no cited atom states
    fitness, or call it safe or best.  These are the conclusions an offer may
    not add either, read here against cited evidence rather than against a
    card, because a situation is stated on carded and uncarded rows alike.
    """

    name = clean_text(product.get("name"))
    recorded = " ".join(clean_text(item.get("text")) for item in evidence)
    if _admission_numeric_tokens(text, name) - _admission_numeric_tokens(recorded, name):
        return True
    if _ADMISSION_BUYER_RECOMMENDATION_ESCALATION.search(text) is not None:
        return True
    if (
        _ADMISSION_BUYER_FIT_VERDICT.search(text) is not None or is_suitability_statement(text)
    ) and not any(is_suitability_statement(clean_text(item.get("text"))) for item in evidence):
        return True
    return any(
        not _admission_causal_relation_is_supported(sentence, evidence, product)
        for sentence in _admission_sentences(text)
    )


def _admission_faq_cep_names_a_customer_entry_point(
    cep: str, evidence: Sequence[Mapping[str, Any]], product: Mapping[str, Any], locale: str
) -> bool:
    """Return whether a FAQ row's ``cep`` names the entry point it exists to name.

    ``cep`` is the planner's note of the situation a shopper arrives in, and
    it reaches no published surface: the FAQPage node is assembled from the
    row's question and its answer alone, and no other field of any node reads
    this string.  The response schema nevertheless makes it a required key of
    every FAQ row while the relationship-card contract never says what the key
    should hold, so the planner writes a plain situation label -- and
    admission used to read that label as publishable copy, asking it to bind
    to a cited claim sentence by sentence.

    A label binds that way only when it happens to reuse the evidence's own
    words.  Swapping nothing but the label on the one safety row that
    published across twelve live runs shows it: an *empty* ``cep`` was
    admitted, the label that shipped (``세안제 선택 전 피부 테스트 이력을
    확인하려는 상황``, against an atom reading ``피부과 테스트 완료``) was
    admitted for echoing ``테스트``, and natural labels for that same row --
    ``메이크업을 깨끗하게 지우고 싶은 경우``, ``아침저녁 매일 쓰는 세안제를 고를
    때``, ``민감 피부 고객이 자극 없는 데일리 클렌저를 고르는 상황`` -- were all
    refused.  A whole row died over the wording of a field that publishes
    nothing.

    So the label is read for what it is: written in the locale being
    published, reading as a fragment of that locale, and speaking of the
    reader rather than of the source.  Publication-grade claim binding is not
    asked of it, because there is no publication to ground.

    What keeps this from letting an ungrounded claim out (C4): the string is
    never rendered, and the label still may not draw a conclusion its cited
    evidence does not state -- a figure, a cause, a fitness verdict, a safety
    or ranking conclusion all remain bound to the evidence by
    ``_admission_situation_concludes_beyond_its_evidence``.  Only the wording
    of the situation is the writer's.  The plan-level ``cep`` array is a
    different field on a different surface and keeps its own validation.
    """

    if not cep:
        return True
    if not _admission_locale_is_supported(cep, locale) or not _admission_text_is_coherent(cep, "fragment"):
        return False
    if not states_a_customer_situation(cep, locale):
        return False
    return not _admission_situation_concludes_beyond_its_evidence(cep, evidence, product)


def _admission_card_question_has_supported_intent(
    question: str,
    card: Mapping[str, Any],
    evidence: Sequence[Mapping[str, Any]],
    product: Mapping[str, Any],
    locale: str,
) -> bool:
    """Admit a natural question when it fits one selected card's source claims.

    Questions are customer queries, not source assertions. They need a real
    situation/goal plus a product or category choice and meaningful lexical
    overlap with the selected card. The answer, rather than the question,
    carries the citation-ready brand and product identity.
    """

    if not _admission_locale_is_supported(question, locale) or not _admission_text_is_coherent(question, "question"):
        return False
    if not _admission_is_customer_decision_question(question, product, locale):
        return False
    claims = _admission_card_claims_for_evidence(card, evidence)
    question_tokens = _admission_card_content_tokens(question, product)
    claim_tokens = {
        token
        for claim in claims
        if clean_text(claim.get("role")) != "identity"
        for value in (
            clean_text(claim.get("text")),
            clean_text(claim.get("ingredient")),
            clean_text(claim.get("benefit")),
            clean_text(claim.get("effect")),
            clean_text(claim.get("outcome")),
            clean_text(claim.get("metric")),
            clean_text(claim.get("timing")),
            clean_text(claim.get("method")),
            clean_text(claim.get("sample")),
        )
        for token in _admission_card_content_tokens(value, {})
    }
    # Category and question scaffolding alone are never a source fit. At least
    # one substantive selected-card atom must connect the customer need to the
    # selected card, even when the question does not name the product.
    return bool(question_tokens & claim_tokens)


def _admission_question_has_supported_intent(
    question: str, evidence: Sequence[Mapping[str, Any]], product: Mapping[str, Any]
) -> bool:
    if (
        _ADMISSION_SENSITIVE_ASSERTION.search(question) is not None
        or _ADMISSION_ASSERTIVE_QUESTION.search(question) is not None
        or any(
            pattern.search(question) is not None for pattern in _ADMISSION_CONTEXTS
        )
    ):
        return sentence_evidence_has_direct_claim_support(question, evidence)
    topic = _admission_question_topic(question)
    roles = {clean_text(item.get("role")) for item in evidence}
    if topic is not None:
        _, allowed_roles = topic
        return bool(roles & allowed_roles)
    question_tokens = set(_admission_tokens(question)) - _admission_product_tokens(product)
    evidence_tokens = {token for item in evidence for token in _admission_tokens(clean_text(item.get("text")))}
    return bool(question_tokens & evidence_tokens)


def _admission_faq_semantic_key(question: str, product: Mapping[str, Any]) -> str:
    topic = _admission_question_topic(question)
    product_tokens = _admission_product_tokens(product)
    synonyms = {
        "ingredient": "formula",
        "ingredients": "formula",
        "formula": "formula",
        "component": "formula",
        "components": "formula",
        "feature": "",
        "features": "",
        "listed": "",
        "list": "",
        "stated": "",
        "state": "",
        "make": "",
        "makes": "",
        "different": "",
    }
    tokens = {
        synonyms.get(token, token)
        for token in _admission_tokens(question)
        if token not in product_tokens and synonyms.get(token, token)
    }
    return f"{topic[0] if topic else 'other'}:{' '.join(sorted(tokens))}"


def _admission_how_to_is_source_faithful(
    how_to: Mapping[str, Any], source_how_to: Mapping[str, Any]
) -> bool:
    if how_to.get("eligible") is not source_how_to.get("eligible"):
        return False
    if how_to.get("ordered") is not source_how_to.get("ordered"):
        return False
    if clean_text(how_to.get("goal")) != clean_text(source_how_to.get("goal")):
        return False
    if as_list(how_to.get("evidenceIds")) != as_list(source_how_to.get("evidenceIds")):
        return False
    actual_steps, source_steps = as_list(how_to.get("steps")), as_list(source_how_to.get("steps"))
    if len(actual_steps) != len(source_steps):
        return False
    for actual_raw, source_raw in zip(actual_steps, source_steps, strict=True):
        if not isinstance(actual_raw, Mapping) or not isinstance(source_raw, Mapping):
            return False
        actual = as_dict(cast(Mapping[str, Any], actual_raw))
        source = as_dict(cast(Mapping[str, Any], source_raw))
        if (
            actual.get("position") != source.get("position")
            or clean_text(actual.get("name")) != clean_text(source.get("name"))
            or clean_text(actual.get("text")) != clean_text(source.get("text"))
            or as_list(actual.get("evidenceIds")) != as_list(source.get("evidenceIds"))
        ):
            return False
    return True


def _admission_is_public_review_evidence(item: Mapping[str, Any]) -> bool:
    """Admit only source-scoped, non-negative customer-feedback signals.

    An actual review body can support its own neutral attribution.  Extracted
    keywords are not quotations, but an explicitly positive keyword can be
    rendered as attributed feedback.  A complete, clearly positive aggregate
    rating can likewise support its own factual rating sentence.  Unknown
    review-shaped fields and mixed or negative signals remain diagnostics-only.
    """

    if clean_text(item.get("role")) != "review":
        return False
    source_path, text = clean_text(item.get("sourcePath")), clean_text(item.get("text"))
    if re.fullmatch(r"product\.reviews\.items\[\d+\]\.body", source_path):
        return is_positive_review_body(text)
    if re.fullmatch(r"product\.reviews\.keywords\[\d+\]", source_path):
        return is_positive_review_keyword(text)
    if source_path != "product.reviews.summary":
        return False
    summary = re.fullmatch(
        r"rating=(?P<rating>[+-]?(?:\d+(?:\.\d+)?|\.\d+)); reviewCount=(?P<count>[+-]?(?:\d+(?:\.\d+)?|\.\d+))",
        text,
    )
    return bool(summary and is_positive_aggregate_rating(float(summary.group("rating")), float(summary.group("count"))))


def _admission_public_copy_evidence(item: Mapping[str, Any]) -> bool:
    """Keep non-review facts plus narrowly permitted customer-feedback evidence."""

    return clean_text(item.get("role")) != "review" or _admission_is_public_review_evidence(item)


_INTERNAL_PLAN_CONTEXT_FIELDS = frozenset({"faqRelationshipCards"})


def _trusted_faq_relationship_cards(request: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Return service-owned FAQ membership context with stable card IDs only."""

    return [
        dict(card)
        for raw_card in as_list(request.get("faqRelationshipCards"))
        if (card := as_dict(raw_card)) and clean_text(card.get("id"))
    ]


def _provider_plan_wire_candidate(candidate: Mapping[str, Any]) -> dict[str, Any]:
    """Separate service-owned context from the provider's strict public wire payload.

    Custom planner adapters sometimes return a conservative plan object, which
    carries ``faqRelationshipCards`` for downstream membership and recovery.
    That field is never part of the provider schema and must never receive
    provider trust; discard the echoed value and later reattach the trusted
    request-owned context.  All other unknown fields remain wire errors.
    """

    return {key: value for key, value in candidate.items() if key not in _INTERNAL_PLAN_CONTEXT_FIELDS}


def _admission_strict_wire_errors(
    candidate: Mapping[str, Any], request: Mapping[str, Any]
) -> tuple[list[str], dict[int, str]]:
    """Separate plan-fatal wire errors from wire errors confined to one FAQ row.

    Semantic rejection below is intentionally field-local.  That distinction is
    safe only after every nested object has the exact public wire shape: a
    partial or type-confused payload must never obtain the service's admitted
    model-plan marker.  An element of the FAQ array is the one exception, since
    that array is a sequence of independent rows: discarding a malformed row
    leaves every other row and field exactly as the provider sent it, so the
    remaining payload is still the complete, shape-checked plan.  The plan's own
    shape, and every singular field within it, stays all-or-nothing.

    Row errors are returned keyed by FAQ index so the caller can drop precisely
    those rows; they are never merged into the plan-fatal list.
    """

    required = {"locale", "productDescription", "webPageDescription", "faq", "howTo", "cep", "warnings"}
    if set(candidate) != required:
        return (
            [
                "Semantic content plan failed strict schema validation: required fields are missing or unknown fields were supplied."
            ],
            {},
        )

    errors: list[str] = []
    faq_row_errors: dict[int, str] = {}

    def confidence(value: object) -> bool:
        return (
            isinstance(value, int | float)
            and not isinstance(value, bool)
            and math.isfinite(float(value))
            and 0 <= value <= 1
        )

    def strings(value: object) -> bool:
        return isinstance(value, list) and all(isinstance(item, str) for item in cast(list[object], value))

    locale = candidate.get("locale")
    if not isinstance(locale, str) or locale not in _ADMISSION_LOCALES or locale != clean_text(request.get("locale")):
        errors.append("Semantic content plan failed locale admission.")

    field_keys = {"include", "text", "intent", "evidenceIds", "confidence", "omitReason"}
    for name in ("productDescription", "webPageDescription"):
        value = candidate.get(name)
        if not isinstance(value, Mapping):
            errors.append(f"{name} failed strict field schema validation.")
            continue
        field_value = dict(cast(Mapping[str, Any], value))
        if set(field_value) != field_keys:
            errors.append(f"{name} failed strict field schema validation.")
            continue
        if not (
            isinstance(field_value.get("include"), bool)
            and isinstance(field_value.get("text"), str)
            and isinstance(field_value.get("intent"), str)
            and strings(field_value.get("evidenceIds"))
            and confidence(field_value.get("confidence"))
            and isinstance(field_value.get("omitReason"), str)
        ):
            errors.append(f"{name} failed primitive field validation.")

    faq_value = candidate.get("faq")
    faq_keys = {"id", "include", "question", "answer", "intent", "cep", "evidenceIds", "confidence", "omitReason"}
    if not isinstance(faq_value, list):
        errors.append("faq failed strict array schema validation.")
    else:
        for index, value in enumerate(cast(list[Any], faq_value)):
            field = f"faq[{index}]"
            if not isinstance(value, Mapping):
                faq_row_errors[index] = f"{field} failed strict field schema validation."
                continue
            faq_item = dict(cast(Mapping[str, Any], value))
            if set(faq_item) != faq_keys:
                faq_row_errors[index] = f"{field} failed strict field schema validation."
                continue
            if not (
                isinstance(faq_item.get("id"), str)
                and bool(clean_text(faq_item.get("id")))
                and isinstance(faq_item.get("include"), bool)
                and isinstance(faq_item.get("question"), str)
                and isinstance(faq_item.get("answer"), str)
                and isinstance(faq_item.get("intent"), str)
                and isinstance(faq_item.get("cep"), str)
                and strings(faq_item.get("evidenceIds"))
                and confidence(faq_item.get("confidence"))
                and isinstance(faq_item.get("omitReason"), str)
            ):
                faq_row_errors[index] = f"{field} failed primitive field validation."

    how_to_value = candidate.get("howTo")
    how_to_keys = {"eligible", "ordered", "goal", "steps", "evidenceIds", "confidence", "omitReason"}
    step_keys = {"position", "name", "text", "evidenceIds"}
    if not isinstance(how_to_value, Mapping):
        errors.append("howTo failed strict field schema validation.")
    else:
        how_to = dict(cast(Mapping[str, Any], how_to_value))
        if set(how_to) != how_to_keys:
            errors.append("howTo failed strict field schema validation.")
        elif not (
            isinstance(how_to.get("eligible"), bool)
            and isinstance(how_to.get("ordered"), bool)
            and isinstance(how_to.get("goal"), str)
            and isinstance(how_to.get("steps"), list)
            and strings(how_to.get("evidenceIds"))
            and confidence(how_to.get("confidence"))
            and isinstance(how_to.get("omitReason"), str)
        ):
            errors.append("howTo failed primitive field validation.")
        else:
            for index, value in enumerate(as_list(how_to["steps"])):
                field = f"howTo.steps[{index}]"
                if not isinstance(value, Mapping):
                    errors.append(f"{field} failed strict field schema validation.")
                    continue
                step = dict(cast(Mapping[str, Any], value))
                if set(step) != step_keys:
                    errors.append(f"{field} failed strict field schema validation.")
                    continue
                position = step.get("position")
                if not (
                    isinstance(position, int)
                    and not isinstance(position, bool)
                    and position >= 1
                    and isinstance(step.get("name"), str)
                    and isinstance(step.get("text"), str)
                    and strings(step.get("evidenceIds"))
                ):
                    errors.append(f"{field} failed primitive field validation.")

    cep_value = candidate.get("cep")
    cep_keys = {"situation", "need", "constraint", "evidenceIds", "confidence"}
    if not isinstance(cep_value, list):
        errors.append("cep failed strict array schema validation.")
    else:
        for index, value in enumerate(cast(list[Any], cep_value)):
            field = f"cep[{index}]"
            if not isinstance(value, Mapping):
                errors.append(f"{field} failed strict field schema validation.")
                continue
            cep_item = dict(cast(Mapping[str, Any], value))
            if set(cep_item) != cep_keys:
                errors.append(f"{field} failed strict field schema validation.")
                continue
            if not (
                isinstance(cep_item.get("situation"), str)
                and isinstance(cep_item.get("need"), str)
                and isinstance(cep_item.get("constraint"), str)
                and strings(cep_item.get("evidenceIds"))
                and confidence(cep_item.get("confidence"))
            ):
                errors.append(f"{field} failed primitive field validation.")

    if not strings(candidate.get("warnings")):
        errors.append("warnings failed strict array schema validation.")
    return errors, faq_row_errors


def _admission_trustworthy_evidence(evidence: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    return [
        item
        for item in evidence
        if not isinstance(item.get("confidence"), int | float)
        or isinstance(item.get("confidence"), bool)
        or float(item["confidence"]) >= 0.6
    ]


def _admission_evidence_states_qualified_metric(item: Mapping[str, Any], product_name: str) -> bool:
    """Return whether a ledger record states a measured result and what qualifies it.

    This decides whether the ledger *holds* a qualified metric, which is what
    makes metric coverage required of a description.  Asking the output-side
    check about a record with that same record as its own evidence compares a
    text with itself, and that holds for any text: a dosage such as ``2 pumps``
    then counts as a qualified measurement and manufactures a requirement the
    copy has to satisfy.  A record qualifies its own figure by stating how it
    was measured or over what period, which is the same qualification the
    output-side check requires copy to carry.
    """

    text = clean_text(item.get("text"))
    if not _admission_numeric_tokens(text, product_name):
        return False
    return _ADMISSION_METHOD.search(text) is not None or _ADMISSION_TIMING.search(text) is not None


def _admission_missing_description_roles(
    text: str,
    evidence: Sequence[Mapping[str, Any]],
    product: Mapping[str, Any],
    field: str,
    *,
    rich_claim: bool | None = None,
) -> list[str]:
    """Return trustworthy source roles a rich description silently omitted.

    This is conditional completeness, not quota filling. A review signal may
    enrich a description only when the model emits an attributed review
    sentence, but it is never a required coverage role: customer feedback is
    optional source context, not a prerequisite for a product summary.
    """

    if rich_claim is None:
        rich_claim = _admission_is_narrative_description(text)
    if not rich_claim:
        return []
    trustworthy = _admission_trustworthy_evidence([item for item in evidence if _admission_public_copy_evidence(item)])
    roles = {clean_text(item.get("role")) for item in trustworthy}
    required: list[tuple[str, frozenset[str], bool]] = [
        (
            "product-intro-or-audience",
            frozenset({"description", "audience", "concern"}),
            bool(roles & {"description", "audience", "concern"}),
        ),
        ("ingredient-or-formula", frozenset({"ingredient", "formula"}), bool(roles & {"ingredient", "formula"})),
        ("benefit-or-effect", frozenset({"benefit", "effect"}), bool(roles & {"benefit", "effect"})),
        (
            "qualified-metric",
            frozenset({"metric"}),
            any(
                clean_text(item.get("role")) == "metric"
                and _admission_evidence_states_qualified_metric(item, clean_text(product.get("name")))
                for item in trustworthy
            ),
        ),
    ]
    if field == "webPageDescription":
        required.append(("usage", frozenset({"usage"}), "usage" in roles))
    return [
        name
        for name, expected_roles, available in required
        if available and _admission_role_position(text, trustworthy, expected_roles) is None
    ]


def _admission_retain_safe_description_sentences(
    text: str,
    evidence: Sequence[Mapping[str, Any]],
    product: Mapping[str, Any],
    locale: str,
    field: str,
) -> tuple[str, int]:
    """Retain independently entailed description sentences, never a partial clause.

    The field-level gate below still checks role ordering, field role, and
    conditional completeness on the retained paragraph.  This narrowly saves
    natural source-backed prose when one separate sentence is unsafe without
    allowing an unsafe sentence to borrow support from its neighbours.
    """

    sentences = _admission_sentences(text)
    retained = [
        sentence
        for sentence in sentences
        if _admission_text_is_supported(sentence, evidence, product, locale)
        and _admission_description_has_complete_final_bindings(sentence, evidence, field)
    ]
    return " ".join(retained), len(sentences) - len(retained)


def _admission_description_public_copy_evidence(item: Mapping[str, Any]) -> bool:
    """Keep raw OCR/page blocks diagnostic-only during model-description recovery."""

    text = clean_text(item.get("text"))
    return bool(
        text
        and _admission_public_copy_evidence(item)
        and not is_raw_page_text_block(text)
        and not is_raw_metric_table_fragment(text)
    )


def _admission_rebind_complete_description_evidence(
    text: str,
    cited: Sequence[Mapping[str, Any]],
    all_evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Recover omitted model IDs only when every sentence has exact safe bindings.

    A provider can compose a grounded paragraph while citing only the
    identity/audience/usage/metric scaffold.  This recovery never grants broad
    ledger authority: each sentence must bind through the final provenance
    selector, every selected record must be publishable, and at least one
    originally cited record must remain in the final binding.
    """

    safe_evidence = [item for item in all_evidence if _admission_description_public_copy_evidence(item)]
    if not safe_evidence:
        return []
    roles = _unique_strings([clean_text(item.get("role")) for item in safe_evidence])
    selected = select_rendered_sentence_evidence(text, safe_evidence, roles)
    sentence_ids = selected["sentenceEvidenceIds"]
    if len(sentence_ids) != len(_admission_sentences(text)) or not sentence_ids or not all(sentence_ids):
        return []
    selected_ids = set(selected["evidenceIds"])
    cited_ids = {clean_text(item.get("id")) for item in cited if clean_text(item.get("id"))}
    if not selected_ids or not selected_ids & cited_ids:
        return []
    # Keep the model's already-safe citations alongside the exact recovered
    # bindings. Some generic admission topic cues (for example Korean
    # ``사용 직후`` in a metric timing) require a role that is not the direct
    # binding for that sentence. The retained model IDs cannot broaden claim
    # support because every sentence is still independently selected below.
    return [item for item in safe_evidence if clean_text(item.get("id")) in selected_ids | cited_ids]


def _admit_model_plan(candidate: Mapping[str, Any], request: Mapping[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
    """Strictly parse a model plan, then retain only independently safe units.

    A malformed plan shape, or a malformed singular field within it, remains
    globally ineligible for model trust.  A malformed FAQ row costs only that
    row, because the rest of the payload is still exactly what the provider
    sent.  Once the wire shape is sound, semantic rejection is likewise local: a
    bad FAQ, CEP, description, or procedure cannot erase a separate
    source-backed model field.  Every rejected public unit becomes deterministic
    source fallback rather than a route around the evidence gate.
    """

    provider_candidate = _provider_plan_wire_candidate(candidate)
    wire_errors, faq_row_wire_errors = _admission_strict_wire_errors(provider_candidate, request)
    if wire_errors:
        return None, wire_errors

    candidate = provider_candidate
    trusted_relationship_cards = _trusted_faq_relationship_cards(request)
    locale = cast(str, candidate["locale"])
    product = as_dict(request.get("product"))
    evidence_by_id = {
        identifier: item
        for raw_evidence in as_list(request.get("evidenceLedger"))
        if (item := as_dict(raw_evidence))
        and isinstance(item.get("id"), str)
        and (identifier := clean_text(item.get("id")))
    }
    all_evidence = list(evidence_by_id.values())
    description_public_copy_evidence = [
        item for item in all_evidence if _admission_description_public_copy_evidence(item)
    ]
    warnings: list[str] = []
    field_decisions: list[dict[str, str]] = []

    def record_field_decision(
        field: str,
        outcome: str,
        *,
        reason: str = "",
        predicate: str = "",
        fallback: str = "",
        row_id: str = "",
    ) -> None:
        """Record a copy-free, field-local admission outcome for diagnostics."""

        field_decisions[:] = [item for item in field_decisions if item["field"] != field]
        decision = {"field": field, "outcome": outcome}
        if reason:
            decision["reason"] = reason
        if predicate:
            decision["predicate"] = predicate
        if fallback:
            decision["fallback"] = fallback
        if row_id:
            decision["rowId"] = row_id
        field_decisions.append(decision)

    def reject_field(field: str, predicate: str, *, row_id: str = "") -> None:
        record_field_decision(
            field,
            "rejected",
            reason="evidenceOrLocaleValidationFailed",
            predicate=predicate,
            fallback="deterministic-source-backed",
            row_id=row_id,
        )

    def ids(value: object, field: str, *, require_when_used: bool) -> list[str] | None:
        raw_ids = cast(list[str], value)
        normalized = _unique_strings(raw_ids)
        unknown = [identifier for identifier in normalized if identifier not in evidence_by_id]
        if unknown:
            warnings.append(f"{field} cites evidence IDs absent from the ledger.")
        accepted = [identifier for identifier in normalized if identifier in evidence_by_id]
        if require_when_used and not accepted:
            warnings.append(f"{field} needs at least one source-backed evidence ID.")
            return None
        return accepted

    def omitted_description(raw: Mapping[str, Any], evidence_ids: list[str], reason: str) -> dict[str, Any]:
        return {
            **raw,
            "include": False,
            "text": "",
            "evidenceIds": evidence_ids,
            "omitReason": clean_text(raw.get("omitReason")) or reason,
        }

    descriptions: dict[str, dict[str, Any]] = {}
    for name in ("productDescription", "webPageDescription"):
        raw = dict(as_dict(candidate[name]))
        included = cast(bool, raw["include"])
        field_ids = ids(raw["evidenceIds"], name, require_when_used=included)
        if not included:
            if clean_text(raw["text"]):
                warnings.append(f"{name} supplied public text while include was false.")
            descriptions[name] = omitted_description(raw, field_ids or [], "The planner did not approve this field.")
            record_field_decision(
                name,
                "omitted",
                reason="modelFieldOmitted",
                predicate="plannerDecision",
                fallback="deterministic-source-backed",
            )
            continue
        if field_ids is None:
            descriptions[name] = omitted_description(raw, [], "Evidence validation failed.")
            reject_field(name, "evidenceIds")
            continue
        field_ids = [
            identifier
            for identifier in field_ids
            if _admission_description_public_copy_evidence(evidence_by_id[identifier])
        ]
        if not field_ids:
            warnings.append(f"{name} cited no public-copy-eligible evidence.")
            descriptions[name] = omitted_description(raw, [], "Evidence validation failed.")
            reject_field(name, "publishableEvidence")
            continue
        text = clean_text(raw["text"])
        rich_claim = _admission_is_narrative_description(text)
        cited = [evidence_by_id[identifier] for identifier in field_ids]
        missing_roles = _admission_missing_description_roles(
            text, description_public_copy_evidence, product, name, rich_claim=rich_claim
        )
        description_supported = bool(text) and _admission_description_is_supported(text, cited, product, locale, name)
        bindings_complete = bool(text) and _admission_description_has_complete_final_bindings(text, cited, name)
        roles_ordered = bool(text) and _admission_description_roles_are_ordered(text, cited)
        supported = bool(text) and not missing_roles and description_supported and bindings_complete and roles_ordered
        if not supported:
            rebound_evidence = _admission_rebind_complete_description_evidence(text, cited, all_evidence)
            rebound_missing_roles = _admission_missing_description_roles(
                text, description_public_copy_evidence, product, name, rich_claim=rich_claim
            )
            rebound_supported = (
                bool(rebound_evidence)
                and not rebound_missing_roles
                and _admission_description_is_supported(text, rebound_evidence, product, locale, name)
                and _admission_description_has_complete_final_bindings(text, rebound_evidence, name)
                and _admission_description_roles_are_ordered(text, rebound_evidence)
            )
            if rebound_supported:
                rebound_ids = [
                    clean_text(item.get("id")) for item in rebound_evidence if clean_text(item.get("id"))
                ]
                warnings.append(
                    f"{name} recovered omitted model evidence IDs from complete sentence-level source bindings."
                )
                descriptions[name] = {
                    **raw,
                    "include": True,
                    "text": text,
                    "evidenceIds": rebound_ids,
                    "omitReason": "",
                }
                record_field_decision(
                    name,
                    "accepted",
                    reason="reboundCompleteSentenceEvidence",
                    predicate="finalEvidenceBinding",
                )
                continue
            retained_text, removed_sentences = _admission_retain_safe_description_sentences(
                text, cited, product, locale, name
            )
            retained_missing_roles = _admission_missing_description_roles(
                retained_text, description_public_copy_evidence, product, name, rich_claim=rich_claim
            )
            retained_supported = (
                removed_sentences > 0
                and bool(retained_text)
                and not retained_missing_roles
                and _admission_description_is_supported(retained_text, cited, product, locale, name)
                and _admission_description_has_complete_final_bindings(retained_text, cited, name)
                and _admission_description_roles_are_ordered(retained_text, cited)
            )
            if retained_supported:
                warnings.append(
                    f"{name} removed unsupported claim sentence(s) while retaining independently source-supported text."
                )
                descriptions[name] = {
                    **raw,
                    "include": True,
                    "text": retained_text,
                    "evidenceIds": field_ids,
                    "omitReason": "",
                }
                record_field_decision(name, "accepted")
                continue
            if missing_roles:
                warnings.append(f"{name} did not preserve required source-role coverage: {', '.join(missing_roles)}.")
            else:
                warnings.append(f"{name} did not pass deterministic locale, role, context, or direct-claim admission.")
            descriptions[name] = omitted_description(raw, field_ids, "Evidence or locale validation failed.")
            predicate = (
                "nonEmptyText"
                if not text
                else "sourceRoleCoverage"
                if missing_roles
                else "sourceSupport"
                if not description_supported
                else "finalEvidenceBinding"
                if not bindings_complete
                else "roleOrder"
            )
            reject_field(name, predicate)
            continue
        descriptions[name] = {
            **raw,
            "include": True,
            "text": text,
            "evidenceIds": field_ids,
            "omitReason": "",
        }
        record_field_decision(name, "accepted")

    if (
        descriptions["productDescription"]["include"] is True
        and descriptions["webPageDescription"]["include"] is True
        and (
            _admission_is_narrative_description(descriptions["productDescription"]["text"])
            or _admission_is_narrative_description(descriptions["webPageDescription"]["text"])
        )
        and _admission_descriptions_are_too_similar(
            descriptions["productDescription"]["text"], descriptions["webPageDescription"]["text"]
        )
    ):
        warnings.append("WebPage.description duplicated the Product narrative instead of providing a distinct page role.")
        descriptions["webPageDescription"] = omitted_description(
            descriptions["webPageDescription"],
            cast(list[str], descriptions["webPageDescription"]["evidenceIds"]),
            "The page description was not distinct from the product entity description.",
        )
        reject_field("webPageDescription", "distinctPageRole")

    faq: list[dict[str, Any]] = []
    faq_keys: set[str] = set()
    relationship_cards = {
        identifier: card
        for card in trusted_relationship_cards
        if card
        and (identifier := clean_text(card.get("id")))
    }
    admitted_card_ids: set[str] = set()
    faq_rejected_rows: list[dict[str, str]] = []

    def reject_faq_row(
        field: str,
        predicate: str,
        row: Mapping[str, Any],
        *,
        row_id: str = "",
        reason: str = "evidenceOrLocaleValidationFailed",
    ) -> None:
        """Reject one FAQ row and retain the sentences its gate refused.

        ``field_decisions`` stays copy-free because every public surface shares
        it.  A rejected FAQ row is the one outcome whose cause cannot be
        reconstructed afterwards: the row never enters ``faq``, so the question
        and answer that failed are gone by the time a run is read back, and a
        predicate name with no sentence attached cannot be traced to the words
        that broke it.  This FAQ-only channel therefore keeps that row's own
        copy beside its predicate.  It is written here and nowhere else, and no
        renderer reads it -- FAQPage is composed from admitted ``plan["faq"]``
        rows, never from ``admissionDiagnostics`` -- so the retained copy stays
        diagnostic and cannot reach a published surface.
        """

        record_field_decision(
            field,
            "rejected",
            reason=reason,
            predicate=predicate,
            fallback="deterministic-source-backed",
            row_id=row_id,
        )
        faq_rejected_rows.append(
            {
                "field": field,
                **({"rowId": row_id} if row_id else {}),
                "predicate": predicate,
                "question": clean_text(row.get("question")),
                "answer": clean_text(row.get("answer")),
                "cep": clean_text(row.get("cep")),
            }
        )

    for index, raw_value in enumerate(cast(list[Any], candidate["faq"])):
        field = f"FAQ[{index}]"
        raw = dict(as_dict(raw_value))
        row_id = clean_text(raw.get("id"))
        if (wire_error := faq_row_wire_errors.get(index)) is not None:
            warnings.append(wire_error)
            reject_faq_row(field, "wireSchema", raw, row_id=row_id, reason="strictFieldSchemaValidationFailed")
            continue
        if raw["include"] is not True:
            record_field_decision(
                field,
                "omitted",
                reason="modelFieldOmitted",
                predicate="plannerDecision",
                fallback="deterministic-source-backed",
                row_id=row_id,
            )
            continue
        card = relationship_cards.get(row_id)
        if relationship_cards and not card:
            warnings.append(f"{field} did not select a known FAQ relationship card.")
            reject_faq_row(field, "relationshipCard", raw, row_id=row_id)
            continue
        if card and row_id in admitted_card_ids:
            warnings.append(f"{field} duplicated FAQ relationship card {row_id}.")
            reject_faq_row(field, "distinctRelationshipCard", raw, row_id=row_id)
            continue
        row_ids = ids(raw["evidenceIds"], field, require_when_used=True)
        if row_ids is None:
            reject_faq_row(field, "evidenceIds", raw, row_id=row_id)
            continue
        row_ids = [identifier for identifier in row_ids if _admission_public_copy_evidence(evidence_by_id[identifier])]
        if not row_ids:
            warnings.append(f"{field} cited only non-publishable customer-review evidence.")
            reject_faq_row(field, "publishableEvidence", raw, row_id=row_id)
            continue
        if card and not set(row_ids).issubset({clean_text(item) for item in as_list(card.get("evidenceIds"))}):
            warnings.append(f"{field} cited evidence outside its selected FAQ relationship card.")
            reject_faq_row(field, "relationshipCardEvidence", raw, row_id=row_id)
            continue
        question, answer, faq_cep = clean_text(raw["question"]), clean_text(raw["answer"]), clean_text(raw["cep"])
        cited = [evidence_by_id[identifier] for identifier in row_ids]
        final_bindings_complete = (
            _admission_faq_card_has_complete_bindings(question, answer, cited, card, product, locale)
            if card
            else _admission_faq_has_complete_final_bindings(question, answer, cited)
        )
        # A formula, usage, safety, or metric card remains its own helpful
        # customer intent even when natural wording mentions customers or
        # "for". Only a selected buyer-decision card carries the target-anchor
        # obligation; legacy uncarded rows retain the generic behavior.
        requires_buyer_anchor = (
            clean_text(card.get("intent")) == "buyer-decision"
            if card
            else _admission_faq_question_requires_buyer_anchor(question)
        )
        buyer_anchor_retained = not requires_buyer_anchor or _admission_faq_answer_retains_buyer_anchor(
            answer, cited, card, product
        )
        buyer_reason_retained = not (
            card and clean_text(card.get("intent")) == "buyer-decision"
        ) or _admission_buyer_decision_has_source_grounded_reason(
            answer, _admission_card_claims_for_evidence(card, cited), product, locale
        )
        customer_decision_question = (
            _admission_card_question_has_supported_intent(question, card, cited, product, locale)
            if card
            else _admission_is_customer_decision_question(question, product, locale)
        )
        answer_has_identity = _admission_answer_has_brand_and_product_identity(answer, product)
        answer_supported = (
            _admission_card_answer_is_supported(answer, cited, card, product, locale)
            if card
            else _admission_text_is_supported(answer, cited, product, locale)
        )
        question_intent_supported = (
            customer_decision_question
            if card
            else _admission_question_has_supported_intent(question, cited, product)
        )
        # A conjunction that reports the same name however it failed cannot be
        # observed.  Only four of these terms had names of their own, and every
        # other way to fail was published as ``sourceSupport``: twelve live runs
        # charged 20 of 32 FAQ rejections to that single label, which names the
        # answer-to-claim check alone, so the gate that actually refused a row
        # was unknowable and each repair had to be guessed.  Every term now
        # carries the function it demands together with the warning that
        # explains it, and a row is rejected under the first unmet term in this
        # order, so the diagnostic names the gate that refused it.  The four
        # predicate names that callers already depend on keep both their
        # meaning and their precedence over the terms that used to hide behind
        # them; ``sourceSupport`` still names the answer-to-claim check and
        # ``finalEvidenceBinding`` stays last, so it still reports only a row
        # whose every other term passed.
        admission_terms: list[tuple[str, bool, str]] = [
            (
                "customerDecisionQuestion",
                customer_decision_question,
                "was omitted because it was not a customer decision question.",
            ),
            (
                "answerIdentity",
                answer_has_identity,
                "was omitted because its answer did not naturally name the product and brand.",
            ),
            (
                "buyerAnchor",
                buyer_anchor_retained,
                "asks about customer fit but its answer did not retain a directly cited audience or concern relation.",
            ),
            (
                "buyerReason",
                buyer_reason_retained,
                "was omitted because its buyer recommendation did not retain a source-grounded formula or effect reason.",
            ),
            ("questionPresent", bool(question), "carried no question text."),
            ("answerPresent", bool(answer), "carried no answer text."),
            (
                "questionLocale",
                _admission_locale_is_supported(question, locale),
                f"asked its question in a language {locale} does not publish.",
            ),
            (
                "answerLocale",
                _admission_locale_is_supported(answer, locale),
                f"answered in a language {locale} does not publish.",
            ),
            (
                "questionSentenceForm",
                _admission_text_is_coherent(question, "question"),
                "did not read as a complete question sentence in its locale.",
            ),
            (
                "separatedMetricClaims",
                not is_compressed_multi_claim_metric_block(answer),
                "flattened several measured claims into one unpunctuated answer instead of stating them as sentences.",
            ),
            (
                "questionIntentSupport",
                question_intent_supported,
                "asked about a topic its cited evidence does not cover.",
            ),
            (
                "sourceSupport",
                answer_supported,
                "was omitted because its answer stated something its cited evidence does not claim.",
            ),
            (
                "cepSupport",
                _admission_faq_cep_names_a_customer_entry_point(faq_cep, cited, product, locale),
                "recorded a customer entry point that does not read as this locale's customer situation, "
                "or that concluded something its cited evidence does not state.",
            ),
            (
                "finalEvidenceBinding",
                final_bindings_complete,
                "answer lacks a complete sentence-level evidence binding. Preserve source-grounded content when possible: "
                "rewrite it as natural sentence(s) that retain each explicit source relationship and cite the exact "
                "supporting evidence IDs. Keep independently supported facts; omit only a clause that would create a new "
                "recommendation, suitability, causal, safety, medical, or numeric conclusion.",
            ),
        ]
        unmet = next(((name, message) for name, met, message in admission_terms if not met), None)
        if unmet is not None:
            predicate, message = unmet
            warnings.append(f"{field} {message}")
            reject_faq_row(field, predicate, raw, row_id=row_id)
            continue
        key = _admission_faq_semantic_key(question, product)
        if key in faq_keys:
            warnings.append(f"{field} duplicated an already admitted FAQ intent.")
            reject_faq_row(field, "distinctCustomerIntent", raw, row_id=row_id)
            continue
        faq_keys.add(key)
        faq.append(
            {
                **raw,
                "include": True,
                **({"id": row_id} if row_id else {}),
                # The row's own ``intent`` is the model describing its topic in
                # free text; the card it selected is what the intent actually
                # is.  Requiring the two strings to match rejected sound rows
                # over a value the service already knew, and a self-reported
                # label verifies nothing that the card's own evidence subset and
                # the question-to-claim overlap do not already verify.
                **({"intent": clean_text(card.get("intent"))} if card else {}),
                "question": question,
                "answer": answer,
                "cep": faq_cep,
                "evidenceIds": row_ids,
                "omitReason": "",
            }
        )
        if row_id:
            admitted_card_ids.add(row_id)
        record_field_decision(field, "accepted", row_id=row_id)

    source_how_to = as_dict(create_conservative_content_plan(request).get("howTo"))
    candidate_how_to = as_dict(candidate["howTo"])
    if candidate_how_to["eligible"] is True:
        how_to_ids = ids(candidate_how_to["evidenceIds"], "howTo", require_when_used=True)
        how_to_supported = how_to_ids is not None and all(
            clean_text(evidence_by_id[identifier].get("role")) == "usage" for identifier in how_to_ids or []
        )
        for index, step_value in enumerate(cast(list[Any], candidate_how_to["steps"])):
            step = as_dict(step_value)
            step_field = f"howTo.steps[{index}]"
            step_ids = ids(step["evidenceIds"], step_field, require_when_used=True)
            cited = [evidence_by_id[identifier] for identifier in step_ids or []]
            step_supported = (
                step_ids is not None
                and all(clean_text(item.get("role")) == "usage" for item in cited)
                and is_concrete_usage_action(clean_text(step["text"]))
                and _admission_text_is_supported(clean_text(step["text"]), cited, product, locale, "action")
            )
            how_to_supported = how_to_supported and step_supported
            if not step_supported:
                warnings.append(f"{step_field} was not an actionable, locale-compatible usage step supported by its cited evidence.")
        if not how_to_supported or not _admission_how_to_is_source_faithful(candidate_how_to, source_how_to):
            warnings.append("howTo did not preserve the canonical source procedure, cardinality, and order.")

    cep_rows: list[dict[str, Any]] = []
    for index, raw_value in enumerate(cast(list[Any], candidate["cep"])):
        field = f"cep[{index}]"
        raw = dict(as_dict(raw_value))
        row_ids = ids(raw["evidenceIds"], field, require_when_used=True)
        if row_ids is None:
            continue
        cited = [evidence_by_id[identifier] for identifier in row_ids]
        components = [clean_text(raw["situation"]), clean_text(raw["need"]), clean_text(raw["constraint"])]
        if not any(components) or any(
            value and not _admission_text_is_supported(value, cited, product, locale, "fragment")
            for value in components
        ):
            warnings.append(f"{field} did not pass locale, context, or direct-claim admission.")
            continue
        cep_rows.append(
            {
                **raw,
                "situation": components[0],
                "need": components[1],
                "constraint": components[2],
                "evidenceIds": row_ids,
            }
        )

    return {
        "locale": locale,
        "productDescription": descriptions["productDescription"],
        "webPageDescription": descriptions["webPageDescription"],
        "faq": faq,
        "faqRelationshipCards": trusted_relationship_cards,
        "howTo": source_how_to,
        "cep": cep_rows,
        "admissionDiagnostics": {
            "fields": field_decisions,
            # Rejected FAQ rows leave no trace in ``faq``, so their own
            # question, answer, and CEP ride beside their predicate here
            # and nowhere else.  The key appears only when a row was
            # rejected, which keeps a clean plan's diagnostics unchanged.
            **({"faqRejectedRows": faq_rejected_rows} if faq_rejected_rows else {}),
        },
        "warnings": _unique_strings([*cast(list[str], candidate["warnings"]), *warnings]),
    }, warnings


def _unique_strings(values: Sequence[object]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        text = clean_text(raw)
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return result


def _planning_clean_text(value: object) -> str:
    """Match the prompt module's local TypeScript ``cleanText`` helper."""

    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", " ", value)).strip()


def _planning_truncate(value: object, maximum: int) -> str:
    text = _planning_clean_text(value)
    return text if js_code_unit_length(text) <= maximum else f"{js_utf16_slice(text, 0, max(0, maximum - 1)).strip()}…"


def _planning_unique_text(values: Sequence[object]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = _planning_clean_text(value)
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return result


def _planning_number(value: object, default: float = 0) -> float:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else default


def _planning_evidence_analysis(item: Mapping[str, object]) -> dict[str, object]:
    text = _planning_clean_text(item.get("text"))
    inference = infer_pdp_evidence_roles_for_ledger(text)
    semantic_roles = _planning_unique_text([role for role in as_list(inference.get("roles")) if role != "source"])
    analysis: dict[str, object] = {}
    if len(semantic_roles) > 1:
        analysis["semanticRoles"] = semantic_roles
    has_evidence_group = item.get("role") == "metric" and bool(re.search(r"(?:^|;\s*)evidenceGroup=[^;]+", text))
    if inference.get("canLinkIngredientToOutcome") is True:
        analysis["relationship"] = "ingredient-outcome"
    elif has_evidence_group:
        analysis["relationship"] = "shared-measurement-group"
    elif _planning_defines_named_technology(text):
        analysis["relationship"] = "named-technology-definition"
    return analysis


def _planning_defines_named_technology(text: str) -> bool:
    value = _planning_clean_text(text)
    match = re.search(r"(?:기술|포뮬러|공법|처방|technology|formula|complex)", value, re.IGNORECASE)
    if match is None:
        return False
    return js_code_unit_length(value[: match.start()].strip()) >= 16 or js_code_unit_length(value[match.end() :].strip()) >= 16


def _select_planning_evidence(evidence: Sequence[object], limit: int) -> list[dict[str, object]]:
    role_priority = {
        "identity": 100,
        "description": 98,
        "metric": 96,
        "benefit": 94,
        "effect": 94,
        "ingredient": 93,
        "audience": 92,
        "usage": 92,
        "faq": 90,
        "source": 88,
        "commerce": 72,
        "review": 68,
    }
    items = [as_dict(item) for item in evidence if as_dict(item)]

    def specificity(item: Mapping[str, object]) -> int:
        path = _planning_clean_text(item.get("sourcePath"))
        if re.search(r"semanticFacts\.metricClaims|semanticFacts\.ingredientBenefitLinks|semanticFacts\.citations", path):
            return 5
        if "semanticFacts." in path:
            return 4
        if "reviews.keywords" in path:
            return 3
        if "reviews.items" in path:
            return 2
        if "sourceTexts" in path:
            return 1 if js_code_unit_length(_planning_clean_text(item.get("text"))) <= 320 else 0
        return 2

    ranked = sorted(
        enumerate(items),
        key=lambda indexed: (
            -role_priority.get(_planning_clean_text(indexed[1].get("role")), 0),
            -specificity(indexed[1]),
            -_planning_number(indexed[1].get("confidence")),
            indexed[0],
        ),
    )
    by_role: dict[str, list[tuple[int, dict[str, object]]]] = {}
    for index, item in ranked:
        by_role.setdefault(_planning_clean_text(item.get("role")), []).append((index, item))
    coverage_targets = {
        "identity": 2,
        "description": 1,
        "audience": 4,
        "ingredient": 10,
        "benefit": 6,
        "effect": 6,
        "metric": 16,
        "source": 18,
        "usage": 8,
        "faq": 6,
        "commerce": 3,
        "review": 8,
    }
    coverage_order = tuple(coverage_targets)
    selected: list[tuple[int, dict[str, object]]] = []
    selected_ids: set[str] = set()

    def add(candidate: tuple[int, dict[str, object]] | None) -> None:
        if candidate is None or len(selected) >= limit:
            return
        identity = _planning_clean_text(candidate[1].get("id"))
        if identity in selected_ids:
            return
        selected.append(candidate)
        selected_ids.add(identity)

    for round_index in range(max(coverage_targets.values())):
        if len(selected) >= limit:
            break
        for role in coverage_order:
            if round_index >= coverage_targets[role]:
                continue
            bucket = by_role.get(role, [])
            add(bucket[round_index] if round_index < len(bucket) else None)
            if len(selected) >= limit:
                break
    for candidate in ranked:
        add(candidate)
        if len(selected) >= limit:
            break
    return [item for _, item in sorted(selected, key=lambda candidate: candidate[0])]


def _select_planning_rag_chunks(chunks: Sequence[object], limit: int) -> list[dict[str, object]]:
    capped_limit = max(0, limit)
    if capped_limit == 0:
        return []
    available = [as_dict(chunk) for chunk in chunks if as_dict(chunk)]
    selected: list[dict[str, object]] = []
    selected_ids: set[str] = set()

    def add(chunk: Mapping[str, object] | None, *, protected_family: bool = False) -> None:
        if chunk is None or (not protected_family and len(selected) >= capped_limit):
            return
        identifier = _planning_clean_text(chunk.get("id"))
        if identifier in selected_ids:
            return
        selected.append(dict(chunk))
        selected_ids.add(identifier)

    for kind in ("field-contracts", "geo-research", "evidence-cards", "cep", "eeat"):
        add(next((chunk for chunk in available if chunk.get("kind") == kind), None), protected_family=True)
    for chunk in available:
        add(chunk)
    return selected


def _select_tone_guidance_chunks(chunks: Sequence[object], limit: int = 3) -> list[dict[str, object]]:
    selected: list[dict[str, object]] = []
    seen_sections: set[str] = set()
    for raw_chunk in chunks:
        chunk = as_dict(raw_chunk)
        if chunk.get("kind") != "best-practice" or len(selected) >= limit:
            continue
        section = f"{chunk.get('source')}:{chunk.get('title') if chunk.get('title') is not None else chunk.get('id')}"
        if section in seen_sections:
            continue
        seen_sections.add(section)
        selected.append(chunk)
    return selected


def _select_planning_review_situations(request: Mapping[str, object]) -> list[dict[str, object]]:
    evidence = [as_dict(item) for item in as_list(request.get("evidenceLedger")) if as_dict(item)]
    review_evidence_by_index: dict[int, str] = {}
    for item in evidence:
        match = re.search(r"product\.reviews\.items\[(\d+)\]", _planning_clean_text(item.get("sourcePath")))
        identifier = _planning_clean_text(item.get("id"))
        if match is not None and identifier:
            review_evidence_by_index[int(match.group(1))] = identifier
    entries: list[dict[str, object]] = []
    for signal in derive_cep_situations_for_planning(as_dict(request.get("product")), _planning_clean_text(request.get("locale"))):
        data = as_dict(signal)
        clause = _planning_clean_text(data.get("clause"))
        if data.get("origin") == "review":
            evidence_ids = [
                review_evidence_by_index[index]
                for index in as_list(data.get("reviewIndexes"))
                if isinstance(index, int) and not isinstance(index, bool) and index in review_evidence_by_index
            ]
        else:
            needle = js_utf16_slice(clause, 0, 40)
            evidence_ids = [
                _planning_clean_text(item.get("id"))
                for item in evidence
                if needle and needle in _planning_clean_text(item.get("text"))
            ][:2]
        if evidence_ids:
            entries.append(
                {
                    "situation": data.get("situation"),
                    "origin": data.get("origin"),
                    "clause": _planning_truncate(clause, 110),
                    "support": data.get("support"),
                    "evidenceIds": evidence_ids,
                }
            )
    return entries[:5]


def create_planning_prompt(request: Mapping[str, object], max_evidence_items: int, max_rag_chunks: int) -> dict[str, str]:
    """Build the source-selected native content-planning provider prompt."""

    selected_guidance = _select_planning_rag_chunks(as_list(request.get("ragChunks")), max_rag_chunks)
    product = as_dict(request.get("product"))
    hints = as_dict(request.get("hints"))
    prompt_preamble: dict[str, object] = {}
    if "locale" in request:
        prompt_preamble["targetLocale"] = request["locale"]
    if "market" in request:
        prompt_preamble["market"] = request["market"]
    if "name" in product:
        prompt_preamble["productName"] = product["name"]
    prompt_preamble.update(
        {
            "requestedSchemaTargets": as_list(hints.get("schemaTargets")),
            "correctiveFeedback": as_list(request.get("planningFeedback")),
            "reviewSituations": _select_planning_review_situations(request),
        }
    )
    if "candidatePlan" in request:
        prompt_preamble["candidatePlan"] = request["candidatePlan"]
    faq_recovery_only = request.get("faqRecoveryOnly") is True
    faq_recovery_card_ids = _planning_unique_text(as_list(request.get("faqRecoveryCardIds")))
    relationship_cards = [
        as_dict(raw_card)
        for raw_card in as_list(request.get("faqRelationshipCards"))
        if as_dict(raw_card)
        and clean_text(as_dict(raw_card).get("id"))
        and (
            not faq_recovery_only
            or clean_text(as_dict(raw_card).get("id")) in faq_recovery_card_ids
        )
    ]
    payload: dict[str, object] = {
        **prompt_preamble,
        "evidenceLedger": [
            {
                **{field: item[field] for field in ("id", "role") if field in item},
                **_planning_evidence_analysis(item),
                "text": _planning_truncate(item.get("text"), 900),
                **{field: item[field] for field in ("sourcePath", "confidence") if field in item},
            }
            for item in _select_planning_evidence(as_list(request.get("evidenceLedger")), max(1, max_evidence_items))
        ],
        "bestPracticeToneGuidance": [
            {
                **{field: chunk[field] for field in ("source", "title", "fieldTargets") if field in chunk},
                "text": _planning_truncate(chunk.get("text"), 500),
            }
            for chunk in _select_tone_guidance_chunks(as_list(request.get("ragChunks")))
        ],
        "toneApplicationPolicy": "Transfer BestPractice voice, cadence, transitions, and evidence density. Do not copy examples or facts.",
        "taskGuidance": [
            _planning_task_guidance(chunk)
            for chunk in selected_guidance
            if chunk.get("kind") != "best-practice"
        ],
        "policyConstraints": [
            f"{'C' if item.get('severity') == 'critical' else 'G'}:{_planning_truncate(item.get('text'), 110)}"
            for item in sorted(
                (as_dict(rule) for rule in as_list(request.get("policyRules")) if as_dict(rule)),
                key=lambda rule: (
                    -int(rule.get("severity") == "critical"),
                    -_planning_number(rule.get("priority")),
                ),
            )
        ],
    }
    if faq_recovery_only:
        payload["faqRecoveryOnly"] = True
        payload["faqRecoveryCardIds"] = faq_recovery_card_ids
    if relationship_cards:
        payload["faqRelationshipCards"] = [
            {
                "id": clean_text(card.get("id")),
                "intent": clean_text(card.get("intent")),
                "productName": clean_text(card.get("productName")),
                **({"brand": clean_text(card.get("brand"))} if clean_text(card.get("brand")) else {}),
                "canRecommend": card.get("canRecommend") is True,
                "claims": [
                    {
                        "role": clean_text(claim.get("role")),
                        "relationship": clean_text(claim.get("relationship")),
                        "text": _planning_truncate(claim.get("text"), 700),
                        "evidenceIds": [clean_text(identifier) for identifier in as_list(claim.get("evidenceIds")) if clean_text(identifier)],
                        **({"ingredient": clean_text(claim.get("ingredient"))} if clean_text(claim.get("ingredient")) else {}),
                        **({"effect": clean_text(claim.get("effect"))} if clean_text(claim.get("effect")) else {}),
                        **({"metric": clean_text(claim.get("metric"))} if clean_text(claim.get("metric")) else {}),
                        **({"value": clean_text(claim.get("value"))} if clean_text(claim.get("value")) else {}),
                        **({"unit": clean_text(claim.get("unit"))} if clean_text(claim.get("unit")) else {}),
                        **({"timing": clean_text(claim.get("timing"))} if clean_text(claim.get("timing")) else {}),
                        **({"method": clean_text(claim.get("method"))} if clean_text(claim.get("method")) else {}),
                        **({"sample": clean_text(claim.get("sample"))} if clean_text(claim.get("sample")) else {}),
                        **({"caveat": clean_text(claim.get("caveat"))} if clean_text(claim.get("caveat")) else {}),
                    }
                    for raw_claim in as_list(card.get("claims"))
                    if (claim := as_dict(raw_claim))
                ],
                "evidenceIds": [clean_text(identifier) for identifier in as_list(card.get("evidenceIds")) if clean_text(identifier)],
            }
            for card in relationship_cards
        ]
    return {"system": f"{_CONTENT_PLANNING_SYSTEM_PROMPT}\n\n{_FAQ_RELATIONSHIP_CARD_PROMPT}", "user": js_json_dumps(payload)}


def _planning_task_guidance(chunk: Mapping[str, object]) -> dict[str, object]:
    metadata = as_dict(chunk.get("metadata"))
    guidance: dict[str, object] = {field: chunk[field] for field in ("source", "title") if field in chunk}
    if isinstance(metadata.get("headingPath"), str):
        guidance["headingPath"] = metadata["headingPath"]
    guidance.update({field: chunk[field] for field in ("kind", "intents", "fieldTargets") if field in chunk})
    guidance["text"] = _planning_truncate(chunk.get("text"), 650)
    return guidance


class ModelBackedContentPlanner:
    """Adapter for injected planners and the retained native provider path."""

    def __init__(self, planner: object) -> None:
        self.planner = planner
        self.provider = create_provider(cast(Mapping[str, Any], planner)) if isinstance(planner, Mapping) else None

    async def plan_content(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        if self.provider is not None:
            config = cast(Mapping[str, object], self.planner)
            prompt = create_planning_prompt(
                request,
                _planning_prompt_limit(config.get("maxEvidenceItems"), _DEFAULT_MAX_EVIDENCE_ITEMS),
                _planning_prompt_limit(config.get("maxRagChunks"), _DEFAULT_MAX_RAG_CHUNKS),
            )
            result = await self.provider.generate_json(
                stage="content-planning",
                system=prompt["system"],
                user=prompt["user"],
                json_schema=pdp_geo_content_plan_json_schema,
            )
            data = as_dict(result)
            usage = data.pop("usage", None)
            return {"plan": data, **({"usage": usage} if usage is not None else {})}
        if not callable(self.planner):
            raise TypeError("content planner must be callable when no native provider is configured")
        value = cast(Callable[[Mapping[str, Any]], object], self.planner)(request)
        resolved = await value if inspect.isawaitable(value) else value
        return as_dict(resolved)


def _planning_prompt_limit(value: object, default: int) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else default


pdpGeoEvidenceKey = pdp_geo_evidence_key
createPdpGeoEvidenceLedger = create_pdp_geo_evidence_ledger
createConservativeContentPlan = create_conservative_content_plan
planPdpGeoContent = plan_pdp_geo_content
pdpGeoContentPlanJsonSchema = pdp_geo_content_plan_json_schema

__all__ = [
    "ModelBackedContentPlanner",
    "create_pdp_geo_evidence_ledger",
    "createPdpGeoEvidenceLedger",
    "create_conservative_content_plan",
    "createConservativeContentPlan",
    "pdp_geo_evidence_key",
    "pdpGeoEvidenceKey",
    "pdp_geo_content_plan_json_schema",
    "pdpGeoContentPlanJsonSchema",
    "plan_pdp_geo_content",
    "planPdpGeoContent",
]
