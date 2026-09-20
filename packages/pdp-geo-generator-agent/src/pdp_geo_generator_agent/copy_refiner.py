"""Optional, evidence-gated public-copy refinement.

The deterministic renderer remains authoritative.  A model may propose a
small set of replacements, but this module accepts only source-supported
public text and performs one bounded corrective retry for rejected fields.
"""

from __future__ import annotations

import copy
import inspect
import json
import re
from base64 import b64decode
from collections.abc import Iterable, Mapping, Sequence
from typing import Any, TypedDict, cast
from zlib import decompress

from neo_js_compat import js_code_unit_length, js_json_pretty_dumps, js_utf16_slice

from ._json import as_dict, as_list, clean_text
from .contracts.analysis_label import has_analysis_label_artifact
from .contracts.metric_statement import naming_identifier_numerics, numeric_tokens, product_naming_surfaces
from .contracts.sentence_form import (
    is_atomic_fact_phrase,
    is_complete_sentence,
    is_korean_complete_sentence,
    is_separator_joined_list,
    korean_phrase_head_token,
    split_into_clauses,
    strip_korean_inflection,
    strip_korean_particle,
)
from .contracts.usage import is_procedural_usage_instruction
from .final_proofreader import clean_proposed_text, sentence_evidence_has_direct_claim_support
from .providers.transport import ProviderTransportError
from .rag.policy import format_policy_checklist_payload, format_policy_compliance_recap
from .token_usage import merge_token_usage
from .validation import serialize_schema_markup

_ANALYSIS_LABEL = re.compile(
    r"(?:evaluation|analysis|metric|assessment)\s*(?:label|metric)?\s*:|(?:평가|측정)\s*(?:지표|결과)\s*:", re.I
)
_MEASUREMENT_SIGN = re.compile(r"^[+\-−]")
_RAW_VOLUME = re.compile(r"\d+(?:\.\d+)?\s*(?:fl\.?\s*oz\.?|m[lL]|g|kg)\b", re.I)
_UNSUPPORTED_CLAIM = re.compile(r"\b(?:cure|cures|treats?|heals?|guaranteed?|clinically proven)\b|치료|완치|보장", re.I)
_WEBPAGE_VOLUME_CONTEXT = re.compile(
    r"(?:옵션|용량)[^.!?。！？]{0,100}(?:구성|선택|판매|가격)|"
    r"(?:option|variant|size|volume)[^.!?。！？]{0,100}(?:available|configured|offered|priced|sold|price)|"
    r"(?:容量|オプション)[^。！？]{0,100}(?:構成|選択|販売|価格)",
    re.I,
)
_PUBLIC_TYPES = ("Product", "WebPage", "FAQPage")
_STRATEGIC_RAG_KINDS = frozenset({"geo-research", "geo-paper", "cep", "eeat"})
_STRATEGIC_RAG_KIND_ORDER = ("geo-research", "geo-paper", "cep", "eeat")
_COPY_REFINEMENT_STATIC = cast(
    dict[str, object],
    json.loads(
        decompress(
            b64decode(
                "tVtfkxy3cf8qqH3hg2Z3349VqjqTlMw4jk7/Sg8kH7AzvbvwzQxGAObu1i5XkTYt06IrpiLToeKjQlWcyHJUMmXJKilWPg1Dxbnd"
                "+w6p7gYwmL3lkRSTJ5LLGUyj0X9+/evGjwZO2t3B1uBVKCF3YvviEA4abVsDw31t3HwhGqOLNndiFxb72hRWyLoQFmoHdQ5WTI2u"
                "wjMX9lSBv2Zi1qoCCjFZiBcvvCQMWJAmn49noIeNbMBk4tyFnUxcGF4Ybg9fy2hNNwchc6f2QHwHrNsx+I8cxJ5WOYzE6xZEpQso"
                "hQFpda3qmXBa5LpqtAVRS9caWQonzQzcsNS5LEE07aRUudg5vyNy3SxY2pnRbY3iTWXu7FlRaFFrJwyUC6FrMVUHUIQ3w0aFg6op"
                "pQM7GmSDAmxuVOOUrsOeB1s/GjStQVkGWwMU1s3BAsknc5cJq1uTw3Ai810oRC7rQhW4Hm6CdyTkRLdOGJXPwYg3YLIjZzBKvkVq"
                "2mFdp7+PxHneAu1RlqVQDip7Vlg+VdSsdUbXM7BOgJdYTLURIPO5mCooC9zXPn/zFV2GTXjxRSNnMLS5bkCUsp61cgZC1cLNle0W"
                "1KYAI/bnUAu5J1UpJyVsBeMYNvyO438qXWf+sETeWqcrtAo+TcX/O4EapsqNYTqFRIPWSQdFZ1TSOJWXIHLlJL8onTNq0vJTewr2"
                "O+MtpXV9dW3Qp8Bn0b5QQQe4/e/q/dc0WaeuyQL8prymztO7Ezrz6DBQO+UWqCVao1ywthIlRcXBgbLORlX1tDR2iwZOqIpMIdd1"
                "DqbORAFOqhLNKtWfbZtGG9TCVNXKzqEYhg941VqvW5sJXYMooGibUuWk3yfUtthXbh69Dy16XLfVBIxopLGqnmWolDo9E5ZwD8Y1"
                "tA7fOvWQZNNAXYjWyhlkqKFKOxBQtDl9X5YC5Z1ps2B/RuXpqMmeQlQ9BSPaulQW5XBgaedGtBbYwkvYgzIc/2jw42xAvoHHfE7X"
                "DkOSRU/n0zjnD2OwNbhIS1N4gQPUoXLC7qKH0OnFkwrnN4TamcWw0ap2mTC6darG+FYB/lsbEm4o20KxgXhLiVpxRtZ2SnYg2tpA"
                "Safkd33GRnPh76LFToysi1dzxcGKnFvX5ULkrTFQu+im/Til6pkBFMJlwkE+r3WpZ4sMY0fVljITjXT0n43RjVHgpFmICtxcF7SN"
                "YDfJDr6Dggj8F/lHofMWd21FJdFbpmXLARctEp8kwUU4RbKoSev45yFtgWXAo5xOVa5kKSjJ2J4EwxxDufFGUrXWCevkQmDI1dNo"
                "MLgPME5xoCerS7XVGJ1DwbauDHBA2MJTkLlrZUmmxHFCNGVr8QQcHDhh23wupBWy0i0pU+syExNdLIQ0IDOOC5mYGngTFbAg4VVt"
                "neE4ICqti5F4BX4AeTwtUUmzC46Vwj5N78mG/VjpesguzsEO9qDm2KPIOJxUtRUSpR57qffATHDrOTSvoFnhBueq8UqQwirX+jir"
                "81xajrjeUE+acq5xC1J5s85la8nju5VJKyHfhn3hKbHGSdo1gBF9rFyEKGeFm0snrKwg6hztJv3SSLzk5mD2FWZnA9KhFujrNepp"
                "j20SLfjNFsxCzBeNxiyu0pB/vssTg63BOQ8/NmURH6LRNkfWm0r/AUv6PBg20jgxaRdghrK2+2BELY2RGCRPSQpi+PxpaWF87sIO"
                "PtK58Ljz4DQw4kOPzxU+VdDDG1MD2d3TZgdcbkNqwLVOzw4XHftwcVrqdRbKKemEnsXAiVZJzoloJNd7YPAv7DIxz4zERczOaAMM"
                "JDOxC9AgaA2bwYgHFsweeHWIPVm2YDNvdZXeA9HWnV61EZWy6B5QiBe2X85E05p8Li1kSSzj1xluUKRKYNlmy9uA0MjVCZ0FTPZI"
                "DLbJhobPr1vHk5rASXTQP95nRmOyKHpK9eEkL6WqbMaHF2BaJozcx1xkVC4mpc53OSFwPpkr67RZdDn+VWikwd2kiJ6j2ewNaTDx"
                "2MHWJYqCnUu9Fj3qQgqrOcdZzrYcyMMbjLZtRnt+naxtkNGqJP35mFVoodd5R9EmvC74bZ+ERQX5XNbKMvaQNak+rNqHKj0pX9sQ"
                "PMhmGqDyalMJEgqi0eDKj7MBHBAmUrreMUobhXkTlXRurtE202juAzRnzXIhfKAr1S7WXTOogQPe0EeTN1uwEW4HY0fppspYhx4U"
                "log1GsdTKKdDn9qgCM+0tXIsgKzF9sXwM9QzTFa5rMWbLeJKjFeICGxrqEpENfh0gnLsGEDQ1cdItoFcIfBwC4EBRUyMlkWXmmPF"
                "hCt8X1IYGW8Cgl1p5XQaz87YgC76sG4jcKR4YBTWk4ngaAm+2qbiXDLE4rDG7oOZX00VFm29EgrRNMoEsbpHO5kaAMRNcCBnMzq6"
                "zuTSmr/3tUrugkisyfpzGBqQxSIqnygIVJxCxIYQXzdOVeqHHFNSdb6gzbfKvZkwMGlVyQYfLWha6n00o2fNuZsKsqdOswiAnyLO"
                "ogiIbL5VOt2Rxq5/jSCZnYMZO+VKGCfp246nip2Dqq2Q4BujMZ0hwdKICiTySIztT4Fy1kn+DnnvXBoousqYlmKLqzEhC1XvYRCt"
                "lCULmahJqfTMyGaucgz2spBOjsT30K43GUbIhFgNYGJIsjVlUAM+nYesIyMoeAZzIxaghycM4/gCaguMK3RbY0WS71ovVLTPaiPL"
                "trVuiGNvhOK5aL9kstKSKeWlbPF0qBxPQGHIIs8l1umNEV9F/6gRTfP7I7G9p1Xha674cqOtBWvR1qLvcIWnAEty8T1tQNaZuFDP"
                "8LD5SP9GNrIG+4yeLPMcGidkUqBGuWqsBx5tfEkJhJ5aggN6pfAQciS2O+qCNwcFESRiauQMbVvksnEtGi0dkuzXNqw0oSxzGYmI"
                "9J2zwgCBUA5DUf+9NbQRulJYrLDWPF85VwVgATOBuaoL9B2n813c0g/aOg/x+NurNdf1HhiskrECpR1a12K96nRl+45vwLalG5bM"
                "QRBCsg5kgRkCcR060kvnXhF2UU10aTORz7HkmYNEH7PIJ2hXawcM0TB85nMoGFMLrIUW1js1MZZJkkOuRFXkqc6/5TRC//AyAjEM"
                "aCG2oGjKtRTSKaRZiSc/ZtYiFo+aQM6zKBCz1wwhZbQtzzmhW008B40/oPCM3HHRGL99qA4wAw4aMAwoI4hCAtx7vw2eiUFQAEVn"
                "6yll/AhSK9pUnC4mQAoLJC2hQYI2jKOQb5HszV4Gny4EUmeEyN5Ad/Lc0TlE7tGVrFPTqZjKskTBO8RqYN8oxxiuAkkIc1NcS20H"
                "IXkzN5JiPYG/sGzg48MR+biCqt2HssQ/Q8jx2DKgR8QTHa0/N7qddfTUcCIt+V9oMRiJlAFCRwyaFqkh1Jx3NpItyrABL2eMeTrc"
                "2oHVNGs+ojgjwIpxwvbKWzLpHgSlmmYktqeOZXUBw2dESOHLTGT7JVJyOOKYiCojuUfZdxNYoUCQBeMl4g3JK6zQTlR7PofEjdt2"
                "QqnPO1DtOxRVPAsZa9pzF3YopiAsO0XJm7JrJVUtCoXyYQGCdraxtvSQ0yChHIyMKlEPe4fet0UpJ1DakXi1rSpp1A/TcN2vcyhG"
                "Q66QGovhhKSZkoe5HraQTpQaaxHGjGdp+4zkgvo9kip8mMVsIkt8qQhcnhXTtix7xBfTEUguRqaiCDpkz9hsr9FbThooW3CoDsnM"
                "OMlPlbfQnpFx2fBoY6VohW852TrMiSon6tYh6BdnLi2//OXy/cPlu4dXVnfviEurn147/ocbyz/87Irgv4rjv7+zuvv56sOry7d/"
                "LS6t7h3ij6vDe8d3bodnVnevi9Vbvzy6f3h8+6PlzRvLm78708uiBhokAknUfYMkkEFM7MCc6tUBTdN7SJmypmXDPDjqLxAwrK6R"
                "+FtcNOmc2rluyyL6Z1CaXscCRIVKG/3Gcm2YWjGbu+26C1OZrwcvTAtDphU7Q9i4t+IxfAxuVzpVUbVZYrYnlo86ESmEyXVVQV1w"
                "aSi2Twk5RP1bp8pSlBj5veGVC0YZvSZO6AbG2MNgmUJNUvA+cneb6VBqNHjQ6/tJaNPUIcAkVJZQYucIrO0aPLFKKVW9Sw5Q9dms"
                "Dc1DaknIfUJDnpuyzPiDPZv4XPB9hlwxeHau/5hN5mVboD86Iz3jlbBRczDKEe8ZkbH19NcmX+022ifbeXsErhAJP1V0IRtf1E4e"
                "cHDu2/y5CztbvXTnS50aoFjjJ5OCea5mc9/CC8SIh4bD53stAwKCQ1ZtY7SeUm0up+AWHogNnxeVdIQmNYk+bgwOI2D5v68xOUx1"
                "azbW2t4WE7jmwFR2JF5CEN83Bg7UJjngiLYTJ0jdOKBp6ecU1nHQE6XHNhmYSHhjkjMNjkTEQEfDyFqWC6tsSIb9A4/m7CNcjCTU"
                "rCzJuNAGMV/kvknoVwquRVbA9XdjNFod/xZWULo+2xHv+D/0PlP8CLSUEzMjK4S5Oelu6muhAEMICvO3n0plDTN/WIg5TwrmBstF"
                "PlDroLFUNOIYydk4TPLC9stj/0Q+h0oS0o7sUNKmS9qJo8GVbMD9METWL7eyVG7xonSA1KpvACbhnHDMHAwrJNl+TBnKBq1WmIQU"
                "ti86Oi/4GYtlM+GBaCwXArEeqLwsBNosZKtA3zLBkoMl2/CibtTvFI+q0MCF8QRmqsZxoQB/AxTrQQnk0af88wmo7CvsONuj6u6I"
                "OjYvbumJxGNsYLvz2pQNPXmaFC3WI0TcAwna1XYcTpM05WV4dMgM+MEmR+yDIc4XRB7ZlyJigmkXcV8t5P7uvjRFys1UukCwZmI7"
                "+vLg+NdfL7+4ighrdf3L1e0b4vi31y8PUNe9//vTv4vlzd8ffXb98gDl3mbOZQMMCisTrWFjKrJZ9Ogsnhz+fXnzd8t/+YqhWSZW"
                "9w6PPvtzxGqc3dcAHCcsrys8eM4dZOqPOVcmgXqtP/QNZ6CeIS9GhuM05mHYX4MwWDMpJycKvZFwiMql79PbFoM9NkAWbBCPkWPt"
                "UGU3K8IUPqOi0L/MmTJItsm8CnEgCIF4zov+ms8h3+WarCvpyRKf2glOCLlOfHuTi2xEAwbXtr6EId9LW3LJ9zbWYjQnxJUMv4ZR"
                "lSAP9WYxYFKBGycd0ukU7K9yAmKPTD52KjP7//bVTVvkw31impiF68iDWH6ncNBzyH7wMR7Oc2IDN9uRzFkSAo4+/Xz1wf3j23eO"
                "Pr2//Mkdsfzj10f3bx3fPhQcAMTRZ/eO7t+lWurwOv5+yUtyZXX3qhiNRuL4Vx8vP/l4+c8fY7CgH966t7x+Y/X+z9hnLw8ycXkQ"
                "X2PBLwXEndLVV5j3QR0NG6axxCW/lSu4DEWmS7zdKw9vvfPg2jsPrn0Sl35w7Y+XHv783775zVdX8OeHt996+O61Kw+uffjg2nsc"
                "u57hfMLoTJg6sCeS1Hjn/M54LcJ0qeGRQwpPEreSjPS4sqwGaYbxh0QAL3hITR4tB1H/L7SzgWRTvv+DPdta7qmZj6dhACIBFnzw"
                "Ha3gh7iQVcfSYGjdokQzRn6CqM2Ow3zywNbV4BzZNpeEzLvF9k8C0KjUr8DMQrqg9oquKjkMZVQhNAdqJEyfUpyTwQiFQOU53ah8"
                "8+ejsqkWvzx4Yfvl1XtXGZ32zP50CZg7xMOiSRU6TWzOYvmheWyFljwJCbXpzvMpckwsQJHE8gPGyhJkTdmEySIxLLTclCdLiIXg"
                "c2GNPVmq4ol3vx5+SRs00dcvfFL4dPvPq5sfi9X1T5dfXB8ffXl/deMeB7tdWCSWxZYUzUuBjbHsv778y4Nrf/jmxq2HN9568NO/"
                "fPP21b9+8O7lQUj5gX3rwd3Yh/IQXDpsqag6RM60sngTCwjypS5Ve5SzqX3HST3Z4dtfHf/jDbH64nD121sngj3vdS1e40N+6TPd"
                "Pv/7F1/99fefPvz5f/zPB3dGoxEH6QfXPnkK8+wwMPG7kZiUaVLkQU+MOThXyAHFT52hkZ5UUBdtns5PvIuQXwxxkCU4aFoMYIM+"
                "gV9xqKuP/LtxFp77wTnGcUcYJ/2uOBcTw+0izK719kpMkz+EYRLWirZqrIc0xCOSSfiPP2EaaqTFmwvIYyWDTdqkrBZ3ioQvFBih"
                "9gaK2SM6L67bCog/IFrGU93JHs0aN5UlDAlOE+IvgTWbLE5MEsSSlSM6TNsyjNnwWJ8fuHycCjx1H0KDjb2gOZRNB4o7/3kt1Kv4"
                "QJh4uTxIjcQb4GKt6vWDgZlvyIVK8jFZmk0TJM52oE2G3HkiYa6X+Wf51amRxJkpK0LfgExygzaSSpAC+bp/cBcmME10ljRmRQd0"
                "bi7dizuvZeJFqFStMvGi1rMSxPZFTvm1JtarN6mVfHAK+HPqN7Q+ycH/F7s/a+NaPJekCMh42j7o5DGqXdufb3mSH+zpsq1gbKkx"
                "5LAsszRFupEFjRMLfck800hrdImRyj4cY+gCXAnSYBDvmi9+kLn2a6AC96RRsnbeeJShhwgdcI/LGC4kp2A2MBIbk/XmTviaVjxp"
                "+KiUefyrXxzdvypWH149fudwC9d8BWLLAH1+K/WMrgXl893jiKUnkxFzOvep/c6HPPzmE0Jw8s6JuSQK9dDqJx+v/ukjsfzwX5d3"
                "/9OXQMsPDsXys89X711f3vooFD2ccCz18nGT40JZbJkgvxta9CmW+Hx58ytx9Kf7R599jT0tSrbvHB59eX95687qN5+L1fu87ulK"
                "yDapIHvi4sYAN/IxmE/asgRnx0Qr0EijHYdZjW6ag4bpuRSlkpmuk4RBGR6wp6Ga9AYJ0rP2xGREOqTAPiZxWqEbTuBrJdR2shTa"
                "iGxnym3hG1FxeIFQoJ6GoW/6iuEifTu4oE8/MZvEl/zIJZVJEVcmvSG10bmJvMW7K9sdwNjRpcoXSN5+H3sKj7rpeAaZxpmfq8x1"
                "PQ0E7XpbLy+lIQ4ql/4J4sdVh/acHySP2Q85Apxn8hOaobfhcW5HTcZpTYz4ezqXk7ZExVIQAWPxwhVWrftzVcbGMsoUhkuJBkGe"
                "kZ7D7/0dze3x1cT+zU44oMkbQrDJdYxp0HwolP0mkFWP/SPG6d3gJvaQ1q4yhYESOpL5ojBrh/FqwCT5vMX+nfTQEttIePuqCYwe"
                "3pGNmsEtfZcWw7yIhVp3g0lSMUl8J8/NGuhNKzb07V6bnm5/Wl3ikOYemFI2ZJ7d5Tcalca7KP6T4Wup9ljpSQ9lfaQm9u1UnAaO"
                "C/aOxAcIn0bJBhSZYLC0dYvy08A40+7JhIikgime9aObBmgUztm1eQniT81U5l2Ki62lKOXkEbfGuJkVplkzuiWVJZabpXfIEgPG"
                "Id/uSlky9YXdm2Ltkt2mu2bhilkcdM7xYhfTFfEemp/TXbuUGGsAf8rhTkrss+GNKQezRcidWOrw/Sh0Ixy9/18="
            ),
            -15,
        ).decode("utf-8")
    ),
)
_REFINABLE_SCHEMA_PROPERTY_NAMES = frozenset(
    {
        "Target customer",
        "Key ingredients and technologies",
        "Ingredient/effect detail",
        "Brand science",
        "Usage",
        "Reported details",
        "Reported assessment summary",
        "Clinical result summary",
        "Customer review context",
    }
)


_COPY_REFINEMENT_SYSTEM_PROMPT = """\
You are a conservative GEO product-copy reasoning agent for structured PDP schema descriptions.
Return strict JSON only: {"schemaDescriptions":{"webPage":"","product":""},"schemaProperties":{"Target customer":"","Brand science":"","Usage":"","Key ingredients and technologies":"","Ingredient/effect detail":"","Reported details":"","Customer review context":""},"faqAnswers":[{"id":"","question":"","answer":""}],"contentSections":{"description":"","quickFacts":"","faq":""},"ruleCompliance":{"violatedRuleIds":[],"notes":[]},"warnings":[]}.
When the user payload includes policyChecklist, treat it as the authoritative budget-bounded rule set selected across the RAG policy documents: every included [critical] rule is a hard constraint, included [guidance] rules apply unless product evidence makes them inapplicable, and rules scoped to a field group apply to that output field.
Work field by field: before writing each output field, scan the policyChecklist group for that field plus the General/cross-field group, then draft the copy to satisfy those rules together rather than reacting to individual rules.
After drafting all fields, run a final self-check against every [critical] rule id and the complianceRecap list; fix violations first, and only report ids in ruleCompliance.violatedRuleIds when a rule genuinely cannot be satisfied with the available evidence, with a short reason in ruleCompliance.notes.
Your job is to use GEO research/geo-paper, CEP, and E-E-A-T guidance to identify product facts, keywords, and source-backed phrases that are likely to be useful in AI answer exposure.
Top priority: make public copy more likely to be selected, quoted, or cited by AI answer engines such as ChatGPT, Gemini, Perplexity, and Google AI by creating concise, self-contained, source-backed answer units.
Use selected strategic chunks as the primary task-specific guidance. Use hydrated full RAG documents only as controlled background for missing context, conflict resolution, and policy completeness.
Use the active BestPractice guidance as the style benchmark for public sentences: transfer its customer-facing confidence, vocabulary level, sentence cadence, evidence density, and natural transitions between CEP, composition, benefit, proof, and review experience. Locale and matched brand guidance refine the voice. Do not copy any BestPractice example, placeholder, product fact, or exact sentence frame; write new prose from productEvidence.
When guidance conflicts, apply this priority: source product evidence first, E-E-A-T trust and claim safety, schema validity, active BestPractice public-copy voice, GEO answer-readiness, then CEP/customer phrasing.
Follow official AI/Search guidance as constraints: build helpful, crawlable, people-first content; do not rely on AI-only markup tricks; make structured data consistent with visible source facts and current PDP evidence.
Extract those useful facts from the supplied product evidence only, then combine them into natural public product sentences.
Treat brand identity RAG documents as brand-image, tone, mood, vocabulary, and positioning guidance only. Patents, official papers, research-center counts, heritage stories, or authority signals inside brand identity documents cannot become product claims, Product.additionalProperty facts, or ingredient/technology evidence unless the current product evidence independently contains the same product-level fact.
Use brand identity keywords and personality to highlight product facts that are already supported by productEvidence, for example making supported barrier-care facts sound derma-science-aware or supported ginseng facts sound refined and ritual-led. Do not connect brand-only patents or papers to the product as proof.
Prioritize concrete facts: product type, target concern or customer entry point, differentiating formula/ingredient, measured effect, usage context, and review-intent language.
Treat Product.name as the representative product entity. Keep SKU badges, bracketed commerce labels, volume/size qualifiers, and option labels in alternateName, offer, option, or FAQ context only when they are source-backed; do not let them dominate Product.description.
Use only the supplied product evidence and strategic RAG guidance. Do not invent claims, ingredients, metrics, study details, prices, awards, or certifications.
Before composing, separate source assertions, source-backed synthesis, and query hypotheses. Public fields may use only source assertions and synthesis whose component facts and relationships are independently supported by productEvidence. RAG CEP examples, generativeQueryIntents, and common category knowledge are non-evidentiary hypotheses, not product facts.
Seasonal/weather contexts, time-of-day, occasions, gifting, travel, life stage, and general category associations may appear in public copy only when productEvidence explicitly supports that same context for the current product. Otherwise keep the association as a diagnostic/query hypothesis and remove the unsupported context from descriptions, FAQ questions/answers, and schemaProperties.
Do not infer causality, suitability, routine placement, or an ingredient-benefit relationship from co-occurrence. A relationship must be explicit in one product-evidence sentence or structured source fact; separately supported nouns may be summarized separately but must not be joined with because, supports, recommended for, or equivalent causal language.
Preserve numeric claims, study populations, usage instructions, ingredient names, and product names exactly when they appear in evidence.
For schemaProperties, refine only existing Product.additionalProperty values. Rewrite rigid labels such as Reported details, Ingredient/effect detail, and Customer review context into natural source-backed target-locale sentences.
For Product.description and contentSections.description: `Product.description` must be composed as a six-part buyer-answer narrative: product introduction/type + target customer and concern/CEP + ingredient or technology composition + supported finished-product benefit/effect + source-stated research or related-article citation + attributed positive or neutral review keywords last. Treat the six-part order as a reasoning arc grounded in CEP and E-E-A-T, never as a list of six field summaries; let CEP determine transitions and clause grouping. Skip any stage whose evidence is missing and let the remaining stages close ranks; never pad a missing stage with category generalities, and never reorder proof before the need it proves. Include only explicitly linked ingredient roles, one deduplicated citation with naturally parsed publisher/title/date/numbers/finding, and one attributed customer-review keyword summary. Keep exact completed safety tests inside the benefit/evidence block. Product.description may be materially more detailed than WebPage.description, but every detail must come from productEvidence. Never invent bibliographic metadata or turn review/commerce copy into a citation. Select ingredients and technologies by routed role and explicit relationship strength rather than an allowlist; do not turn an educational FAQ/category statement into a current-product ingredient. Use wording that naturally answers likely generative-search intents such as who it is for, which concern it addresses, which ingredient matters, which result is officially supported, and what customers say. Do not use page-level wording such as "product page" inside `Product.description`; reserve page/resource language for `WebPage.description`.
Rewrite Product.description as one CEP-led explanation rather than a field-by-field list. Connect concern -> suitable product context -> composition -> explicitly supported component role -> finished-product outcome -> study context with natural transitions, but never create an ingredient/outcome causal link from co-occurrence. Merge metrics from the same evidenceGroup and outcome family into one sentence; state the common institution, period, population, and method once and preserve each timing-to-value pair.
Use the exact full product name in the Product.description introduction and, when composition evidence exists, again as the subject of the primary ingredient/composition sentence. After those two attribution anchors, use a natural omitted, ingredient, technology, or formula subject instead of repeating the full name mechanically.
For Product.description and contentSections.description in every locale, keep the CEP readable by splitting dense clauses when needed: first state product identity for the target customer or concern, then connect ingredient/formula evidence to the supported benefit. Avoid one-sentence noun stacks such as "[target customer]을 위한 [product name]은 [ingredients/formula]의 [benefit product type]입니다", "[product] is a [benefit product type] of [patent-pending formula]", or "[target]向けの[product]は[処方]の[商品]です". Infer the ingredient/technology role and use natural locale predicates: ingredient/capsule facts are included or blended, formula/process facts are used/adopted/applied, and mixed ingredient-plus-formula facts become the basis or composition for the supported benefit. Keep patent-application wording in Brand science/additionalProperty when needed.
Usage context belongs in Usage/HowTo and must not interrupt the `Product.description` order. Routine placement and concrete application steps stay out of Product.description and contentSections.description.
For faqAnswers, return the COMPLETE FAQ list in the exact order supplied by currentCopy.faqAnswers. Every item must retain that row's immutable id, and every supplied id must appear exactly once. Do not add, remove, merge, split, or reorder FAQ rows. Never use a raw source FAQ heading as the public question; preserve the existing model-authored customer-decision intent while improving fluency only.
Build each FAQ question backwards from a natural recommendation or comparison query, then build its answer forwards from productEvidence. For example, turn an indirect query such as '[concern A] and [concern B] product recommendation' into the product-specific question 'Is [product] suitable for customers with [concern A] and [concern B]?' only when those concerns are supported. A direct effect-to-experience bridge is allowed when evidence entails it: an immediate cooling result and water-cream formula may become a question for customers seeking a cool, refreshing feel in hot conditions or after sweating, but the answer must not claim sweat control, heat treatment, or any effect beyond cooling. Product-specific questions must name the exact product instead of using a deictic subject that only points at the product, such as 이 제품, 이 크림, this product, or this cream. generativeQueryIntents are non-evidentiary query hypotheses: use one only to identify a possible underlying intent, then rewrite the question using solely the context that productEvidence supports. Never claim verified query volume, and never copy an unsupported season, occasion, audience, causal premise, or general category association into the public question. Order FAQ by buying-consultation intent: recommendation/suitability first, then key ingredients/benefits, texture/use-feel, usage/routine, comparison/sameness, and evidence/measured results last; skip intents that have no evidence.
For a benefits FAQ, use natural customer wording: name the product, name the concern or outcome the buyer is deciding about, and mention a test result only when finished-product human-application or clinical evidence exists. Without that evidence, ask only what the product helps with. Never ask for the internal evidence record ('what product evidence supports them?'), and never call a PDP-reported study published, peer-reviewed, or 공개된 without a matching bibliographic citation. Do not copy a question wording out of these instructions — the properties are the rule, not a phrase to emit.
For FAQ questions that ask a yes/no determination such as sameness, compatibility, or suitability, begin the answer with 네, or 아니요, (Yes,/No, in English locales) when productEvidence supports the determination, followed by one supported fact sentence. When the evidence cannot support the determination, do not guess and do not lead with a non-answer; answer the underlying intent directly with this product's supported fact.
For FAQ breadth, prefer BestPractice-level coverage when evidence exists: benefit, ingredient/technology, usage, skin suitability, positive review use-feel intent, evidence/metric, variant comparison, routine synergy, persistence, renewal/replacement, and purchase/gift context. Keep unsupported intents unchanged rather than inventing answers.
For faqAnswers, make the first sentence directly answer the question and stand alone as a citation-ready claim unit: include the product name, target concern or customer, product type, key ingredient/technology, benefit/effect, usage context, or metric only when each fact is supported.
For suitability and recommendation FAQ answers, preserve this evidence ladder when each rung is available: explicit concern and target customer -> supported finished-product benefit/effect -> the most relevant finished-product study result rewritten as proof of that benefit -> each ingredient's explicitly stated role -> recommendation bounded to the supported customer/concern -> individual-results-may-vary qualifier for study results. Omit unsupported rungs. Do not paste institution/date/sample/method/outcome fields as an isolated report sentence. If ingredient roles and finished-product results are not explicitly linked, keep them as separate claims rather than implying one ingredient caused the complete result.
For Korean and English public copy, avoid meta-narration: outside the opening WebPage.description page-introduction sentence, do not make the page, source material, evidence, information, product details, usage guidance, context, or generation process the grammatical subject of a sentence. The customer-facing subject should be the product, ingredient/technology, benefit, usage action, review pattern, option, or customer concern.
For English public copy, avoid observer frames such as "source-backed evidence reports", "product details include", "usage guidance covers", "texture context supports", or "routine context can be compared". Prefer direct product sentences such as "the formula includes", "customer reviews mention", "the product is suitable for", "use it", or "the option differs by".
Do not reuse the same description for `WebPage.description` and `Product.description`. Both descriptions must follow introduction -> target customer -> composition -> benefit/effect -> research/article citation -> attributed review keywords, but WebPage is a compact page/brand/scope summary and Product is the detailed product-entity narrative. Keep ingredients and benefits parallel unless explicit source evidence links them. Add brand history or expertise only when separate current-source brand evidence states it. Do not copy exact HowTo actions or raw report-like metric blocks.
For Korean WebPage.description, keep '상품 페이지' or equivalent page-scope language in the opening only. In later sentences, name the exact product or use the customer concern, ingredient/technology, finished-product study, test, offer, or review as the subject. Reject repeated wrappers such as '페이지 본문에서는', '페이지에서 확인할 수 있는', and '페이지에 공개된', and turn the supported facts into a compact CEP-led narrative.
Avoid vague WebPage helper wording such as "The page helps answer". Name the product, brand, and actual page scope in natural target-locale prose.
For every locale, WebPage.description openings should identify the product page and source-backed brand before summarizing page coverage. Do not insert concrete usage actions, raw metrics, or a product-benefit sales claim into the opening.
For Korean WebPage.description, generate a natural product-first page introduction that names the exact product and source-backed brand. Do not reuse '[브랜드]의 [상품명] 상품 페이지는 [제품 유형] 상품을 소개합니다' or any other fixed replacement template; keep page scope separate from later product claims.
For every locale, do not turn page coverage into a new unsupported recommendation, suitability, efficacy, or superiority claim. Source-backed customer fit and finished-product efficacy may be stated directly after the page opening when their scope is preserved.
For every locale, do not make a skin type, skin condition, or concern itself the grammatical actor of comparing, selecting, referencing, or checking product information. Write the customer, shopper, concern context, or product page as the actor/beneficiary.
For every locale, do not make the target customer the subject of a concrete usage action. Put routine timing and application actions in Usage/HowTo coverage, not in the target-customer clause.
For every locale, avoid full application directions in WebPage.description. Concrete steps such as dispense into palm, apply over face, spread, pat, rinse, massage, or absorb belong in HowTo or Usage. WebPage.description may mention routine or usage coverage only at a high level.
For every locale, WebPage.description may summarize supported section types once, but must not narrate individual FAQ questions, HowTo actions, or purchase instructions.
For every locale, page-coverage wording is valid in WebPage.description and invalid in Product.description. Keep detailed methods, disclosures, caveats, ungrouped certifications, and raw metric strings in dedicated properties or evidence FAQ rather than report-style sentences; exact completed safety tests may stay in the benefit/evidence block.
For Product.description in every locale, connect target customer, ingredient/technology, and benefit/effect only when evidence supports the relationship. When ingredient and finished-product benefit facts are separate, keep their claim scopes parallel under the product subject and connect the prose with reference or cadence, never with an invented causal connector.
For every locale, do not use patent numbers or patent-application identifiers in WebPage.description. Keep patent identifiers in Brand science/Product.additionalProperty; WebPage.description should stay focused on product-page identity, source-backed brand identity, and page scope.
For every locale, omit FAQ-topic navigation sentences such as "questions about why the capsule floats are also covered". FAQ topics belong in FAQPage, not in WebPage.description.
For Product.description, do not combine an ingredient/technology list and multiple numeric test results into one awkward sentence. Split composition from the supported benefit/evidence block.
For Korean metric sentences, preserve source scientific test-method labels such as English or Latin method names instead of inventing translations. Place the method label before the measured result, e.g. "[method] 테스트에서 [subject] [value]", so it is not mistaken for an example marker or a product benefit.
For every locale, avoid report-style predicates such as "results are presented/shown", "figures are provided", "결과가 제시됩니다", "수치가 제시됩니다", or "나타났습니다" unless the question explicitly asks about evidence or source reporting. For numeric evidence, infer a natural predicate from the measured change, such as recovered, increased, improved, decreased, lasted, or remained.
For WebPage.description, use the supported page coverage as a CEP narrative rather than a section list. Do not copy a HowTo action or raw OCR metric string; when grouped finished-product evidence directly supports the customer decision, turn it into one concise natural study sentence.
For WebPage.description, do not merge a HowTo step with FAQ topics. A compact section-scope list is enough.
For WebPage.description, keep brand context and page scope separate from current-product mechanisms. Brand-only science cannot prove a product benefit.
For WebPage.description in every locale, do not expose internal analysis labels or patent identifiers. Use natural page-scope nouns in the target locale.
Keep raw volume/size strings out of Product.description. WebPage.description may include a source-backed option/size together with its matching price in one natural offer sentence; never present a bare size fragment or mix a variant's size with another variant's price.
For WebPage.description, connect the product-page introduction, brand identity, concrete supported information, and remaining page scope with natural transitions. Keep it compact and avoid a detailed second product narrative.
Do not force irrelevant measured evidence into either description. If a metric directly answers the supported concern, use one natural outcome sentence; in WebPage.description, retain concise values and timing only when they form a source-grouped finished-product result, while full methods, caveats, and disclosures stay in Reported details.
Treat review bodies or review examples that consist only of volume/size strings, product labels, or product names as non-review data: never use them as review context, review keywords, or use-feel evidence.
For Target customer, infer the customer from explicit source evidence. Prefer stated skin type, concern, routine moment, or customer-entry-point evidence. Do not infer visible-aging, wrinkle, or anti-aging intent from weak texture or generic care words unless explicit aging/wrinkle/anti-aging evidence exists.
For Brand science, use only current product-source-backed ingredient, technology, formula, patent, proprietary method, or research evidence. If a patent, paper, research center, or official article appears only in a brand identity document, keep it as brand-image/diagnostic context and do not write it as a product property.
For Usage, include only procedural directions that combine an actual use action with context such as amount, tool, body area, order, frequency, or instruction mood. Exclude formula mechanisms, technology explanations, measured results, review comments, product marketing copy, benefit claims, and application-effect descriptions that merely say what happens when the product is used.
Do not solve copy quality by copying a fixed template. Infer the sentence structure from the target locale, product type, supported evidence, user intent, and field role. Vary syntax naturally while keeping the claim verifiable.
For Korean and English faqAnswers, write direct recommendation and product-introduction sentences. Start with the answer itself, then connect supported facts as customer need -> formula or effect -> proof -> bounded recommendation. Use natural predicate families such as suitability, inclusion, care support, benefit delivery, usage action, comparison, or measured result; avoid passive observer/reporting endings such as 설명됩니다 or 안내됩니다 unless the question literally asks what a source says. For supported infant/pregnancy use questions, name the product, state the supported test/use scope directly, recommend it only within that scope, and finish with any source-stated patch-test or professional-consultation precaution.
Never start an FAQ answer with source narration such as 제품 FAQ에서는, 상품 정보에 따르면, the product FAQ says, according to the page, or equivalent Japanese wording. For supported suitability and concern questions, answer in the order product + target concern/customer + supported finished-product effect; add an ingredient role only when productEvidence contains an explicit ingredient-benefit link. Use recommendation wording only when explicit suitability/recommendation evidence supports it, and never strengthen a neutral source answer merely because the question was reframed.
Before returning public copy, collapse synonymous skin types and customer concerns into one expression in the requested locale; do not emit Korean and English duplicates together. Treat paraphrases of the same application action as one Usage/HowTo step, and keep test application or measured post-application results out of Usage/HowTo.
Product highlights, benefit statements, and review-backed positive points must be routed into `Product.description`, `additionalProperty`, and visible benefit sections. Use repeated positive or neutral customer review language to infer review-backed recommendation contexts in Product.additionalProperty when it connects a customer situation to supported benefits, ingredients, and use-feel. Exclude negative review sentiment, scent complaints, ratings, and raw reviewer snippets.
When deriving search questions from review-backed CEP, treat an indirect query as a customer-situation/category question that does not mention the product or brand, and a direct query as a product/brand-explicit question. Infer query wording from the customer need, product category, brand/product entity, supported benefits, and key ingredients rather than copying a fixed template.
Keep inferred direct and indirect queries answer-ready: pair each question with short source-backed answer evidence and core keywords. `PropertyValue.name` must be a stable property label such as `Indirect customer question` or `Direct product question`; do not put a full customer situation phrase or full question in `name`. Keep the inferred question/answer context in PropertyValue.value or route true Q/A pairs to FAQPage.mainEntity. Do not prefix values with labels such as direct query, indirect query, core keywords, or 핵심 키워드. Diagnostics should retain the query kind, question, keywords, answer basis, and whether the product or brand was mentioned.
Do not create or preserve FAQ answers whose only purpose is customer-review sentiment, rating, scent preference, or reviewer experience. Positive review-intent FAQ may summarize reusable use-feel signals, while review-derived recommendation contexts belong in Product.additionalProperty.
For Korean FAQ answers asking whether two capsules, variants, products, or ingredients are the same, answer the same/different point first only when the evidence supports it. When the evidence cannot confirm sameness, never lead with a cannot-confirm sentence such as "동일 여부는 확인하기 어렵습니다"; instead answer the underlying intent directly with this product's supported fact (what this product's capsule/formula is). Keep only one concise source-backed support phrase; do not append patent application numbers or broad formula-technology explanations unless the question asks about patents.
Never publish a FAQ answer that opens with a non-answer declaring that the fact is unknown, undisclosed, or impossible to confirm, because answer engines cite standalone answer sentences and a cannot-confirm lead makes the whole Q/A uncitable. The same applies to any description or property value. When evidence cannot answer the asked comparison, answer the underlying intent with this product's supported fact; when no supported fact exists, drop the question entirely.
Do not repeat the same metric clause, measured value, or list item twice within one sentence or one property value (e.g. duplicated "사용 7일 후 87.3% 회복" clauses or duplicated skin-type items). Each measured result appears exactly once per field.
For suitability/benefit questions, infer a natural sentence that connects product, customer concern, product type, and supported benefit. Do not force a fixed wording pattern when the evidence points to another structure.
For Korean suitability/benefit FAQ answers, preserve supported numeric values but use customer-facing effect predicates such as "효과가 있습니다" or "도움이 됩니다" instead of report-style endings such as "결과가 제시됩니다", unless the question asks for evidence, tests, or reported results.
Write caveats as direct customer-facing sentences, such as "개인 차가 있을 수 있습니다" or "Individual results may vary." Never describe a disclaimer, caveat, qualifier, condition, or note as being attached, shown, or stated.
For Korean evidence/test FAQ answers, avoid "나타났습니다" and "제시됩니다"; prefer natural direct-result wording such as "[method] 기준, [measured subject]은/는 [value] 개선되었습니다/증가했습니다/회복되었습니다".
For ingredient/technology questions, infer a natural sentence that connects ingredient or technology to the supported benefit without inventing a mechanism.
Never add a new number, percentage, duration, sample size, study population, usage period, certification, or claim mechanism that is absent from productEvidence or currentCopy.
Rewrite OCR-like evidence into natural target-locale sentences before using it. Never copy raw all-caps image text, footnote markers, bilingual product labels, or alternate-language product-type labels into public copy.
Respect field evidence contracts: HowTo and usage answers may contain only actionable source directions; ingredient sections may contain only ingredient/formula/full-INCI evidence; benefit sections may contain only source-backed finished-product outcomes, effects, or concise evidence topics. If a benefit appears only in review language, it must be phrased as customer-reported experience instead of an objective product effect.
If a sentence is useful evidence but belongs to a different field, rewrite it only in the correct field and do not move the raw phrase across public fields.
Internal terms that name the generation pipeline or the evidence system must never appear in public schema values or public PDP content: no RAG, GEO, geo-paper, CEP, E-E-A-T, schema optimization, citation-ready, OCR, image caption, product shot, pack shot, with text, or in the corner.
Keep the output in the requested locale. Describe the PDP as a page or content resource in `WebPage.description` and the product entity itself in `Product.description`, because schema.org treats `description` as the description of the item being marked up.
If evidence is insufficient, return the current copy unchanged and explain the limitation in warnings.
When the user payload includes refinementFeedback, this is a corrective pass: regenerate ONLY the fields listed in refinementFeedback, fixing the stated rejection reason while keeping all other rules satisfied. Return empty strings or omit every field that is not listed in refinementFeedback."""


class CopyRefinementContractError(RuntimeError):
    """An injected refiner answered outside the refinement response contract."""


def _is_declared_refinement_failure(error: BaseException) -> bool:
    """Return whether the boundary anticipated this failure instead of being defective.

    The transport layer declares one type for everything that can go wrong
    between this process and a provider, and this module declares one for a
    refiner that answers outside its contract.  Both are outcomes of trying to
    use a model, and public copy must survive them.  Anything else arriving here
    is a defect in this code; filing a defect as a content decision is how a
    broken run comes to read exactly like a clean one.
    """
    return isinstance(error, (ProviderTransportError, CopyRefinementContractError))


def _model_call(outcome: str, called: bool = True) -> dict[str, Any]:
    """Record whether the model ran, so a reader never has to infer it."""
    return {"called": called, "outcome": outcome}


class _CopyRefinementPrompt(TypedDict):
    system: str
    user: str


async def refine_pdp_geo_copy(input_: Mapping[str, Any], options: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Apply a custom/provider refinement response through deterministic gates."""

    runtime = as_dict(options)
    base = _base_application(input_)
    refiner, warning = _resolve_refiner(runtime)
    if refiner is None:
        if warning:
            base["warnings"].append(warning)
            base["evidence"].append(
                {"field": "copy.refinement", "source": "llm", "value": f"Copy refinement skipped: {warning}"}
            )
        return base
    try:
        first = await _refine(refiner, input_)
        applied = _apply_refinement(input_, first)
        warnings = [*[str(item) for item in as_list(first.get("warnings"))], *applied["warnings"]]
        evidence = [*applied["evidence"]]
        usage = first.get("usage")
        retry_targets = _collect_retry_targets(applied, input_)
        if retry_targets:
            retry_request: dict[str, Any] = {
                key: value for key, value in input_.items() if key != "hydratedRagDocuments"
            }
            retry_request.update(
                {
                    "schemaMarkup": applied["schemaMarkup"],
                    "content": applied["content"],
                    "refinementFeedback": retry_targets,
                }
            )
            try:
                second = await _refine(refiner, retry_request)
                retry = _apply_refinement(retry_request, second)
                usage = _merge_usage(usage, second.get("usage"))
                warnings.extend(str(item) for item in as_list(second.get("warnings")))
                warnings.extend(retry["warnings"])
                remaining = _collect_retry_targets(retry, retry_request)
                if remaining:
                    warnings.append(
                        "Corrective refinement pass could not repair: "
                        + ", ".join(str(item.get("field") or "") for item in remaining)
                        + " (corrective refinement pass exhausted)."
                    )
                evidence.extend(retry["evidence"])
                evidence.append(
                    {
                        "field": "copy.refinement.retry",
                        "source": "llm",
                        "value": "Corrective refinement pass regenerated fields: "
                        + ", ".join(str(item.get("field") or "") for item in retry_targets),
                    }
                )
                applied = {
                    **retry,
                    "applied": bool(applied["applied"] or retry["applied"]),
                    "rejections": retry["rejections"],
                }
            except Exception as error:  # one-shot degradation, never a silent one
                if not _is_declared_refinement_failure(error):
                    raise
                warnings.append(f"Corrective refinement pass skipped: {str(error) or 'provider failed.'}")
                evidence.append(
                    {
                        "field": "copy.refinement.unavailable",
                        "source": "llm",
                        "value": "Corrective refinement pass could not reach a usable model response: "
                        + (str(error) or "provider failed."),
                    }
                )
        if applied["applied"]:
            evidence.append(
                {
                    "field": "copy.refinement",
                    "source": "llm",
                    "value": "Model-backed copy refinement accepted only source-supported public-copy replacements.",
                }
            )
        else:
            evidence.append(
                {
                    "field": "copy.refinement",
                    "source": "llm",
                "value": "Model-backed copy refinement returned no accepted public-copy changes.",
                }
            )
        strategic_sources = _strategic_exposure_source_summary(input_)
        if strategic_sources:
            evidence.append(
                {
                    "field": "copy.refinement.strategy",
                    "source": "rag",
                    "value": "Strategic copy selection considered GEO research/geo-paper, CEP, and E-E-A-T guidance from: "
                    + strategic_sources,
                }
            )
        policy_rules = [as_dict(item) for item in as_list(input_.get("policyRules")) if as_dict(item)]
        if policy_rules:
            critical_count = sum(1 for rule in policy_rules if rule.get("severity") == "critical")
            evidence.append(
                {
                    "field": "copy.refinement.policy",
                    "source": "rag",
                    "value": "Compiled policy checklist injected "
                    f"{len(policy_rules)} rules ({critical_count} critical) from all loaded RAG policy documents.",
                }
            )
            rule_compliance = as_dict(first.get("ruleCompliance"))
            violated = _unique_strings(as_list(rule_compliance.get("violatedRuleIds")))
            notes = _unique_strings(as_list(rule_compliance.get("notes")))
            if violated:
                warning_text = "Copy refinement reported unsatisfied policy rules: " + ", ".join(violated)
                if notes:
                    warning_text += " (" + " / ".join(notes) + ")"
                warnings.append(warning_text)
            elif rule_compliance:
                evidence.append(
                    {
                        "field": "copy.refinement.policy",
                        "source": "llm",
                        "value": "Copy refinement self-check confirmed all critical policy rules were satisfied.",
                    }
                )
        warnings = _unique_strings(warnings)
        evidence.extend({"field": "copy.refinement.warning", "source": "llm", "value": warning} for warning in warnings)
        return {
            "schemaMarkup": applied["schemaMarkup"],
            "content": applied["content"],
            "faqMembership": applied["faqMembership"],
            "evidence": evidence,
            "warnings": warnings,
            "usage": usage,
            "called": True,
            "applied": applied["applied"],
            "rejections": applied["rejections"],
            "modelCall": _model_call(_refinement_outcome(applied)),
        }
    except Exception as error:  # a declared failure must preserve deterministic output
        if not _is_declared_refinement_failure(error):
            raise
        message = str(error) or "Copy refinement provider failed."
        return {
            **base,
            "called": True,
            "warnings": [message],
            "evidence": [
                {
                    "field": "copy.refinement.unavailable",
                    "source": "llm",
                    "value": f"Copy refinement could not reach a usable model response: {message}",
                }
            ],
            "modelCall": _model_call("unavailable"),
        }


class ModelBackedCopyRefiner:
    """Provider-neutral copy-refiner adapter."""

    def __init__(self, config: Mapping[str, Any]) -> None:
        self.config = dict(config)

    async def refine_copy(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        from .providers import create_provider

        provider = create_provider(self.config)
        prompt = create_copy_refinement_prompt(request)
        return await provider.generate_json(
            stage="copy-refinement",
            system=prompt["system"],
            user=prompt["user"],
        )

    async def refineCopy(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        return await self.refine_copy(request)


def create_copy_refinement_prompt(request: Mapping[str, Any]) -> _CopyRefinementPrompt:
    """Build the field-separated, RAG-aware model boundary retained by the TS agent."""

    return {
        "system": _COPY_REFINEMENT_SYSTEM_PROMPT,
        "user": js_json_pretty_dumps(create_copy_refinement_payload(request)),
    }


def create_copy_refinement_payload(request: Mapping[str, Any]) -> dict[str, object]:
    """Port the selected legacy copy-refinement model payload exactly."""

    product = as_dict(request.get("product"))
    markup = as_dict(request.get("schemaMarkup"))
    content = as_dict(request.get("content"))
    sections = as_dict(content.get("sections"))
    json_ld = as_dict(markup.get("jsonLd"))
    graph = _records(json_ld.get("@graph"))
    product_node = _find_node(graph, "Product")
    faq_node = _find_node(graph, "FAQPage")
    policy_rules = [as_dict(item) for item in as_list(request.get("policyRules")) if as_dict(item)]
    rag_chunks = [as_dict(item) for item in as_list(request.get("ragChunks")) if as_dict(item)]
    semantic = as_dict(product.get("semanticFacts"))
    source_texts = _select_high_value_evidence_texts(as_list(product.get("sourceTexts")), 10)
    benefits = _select_high_value_evidence_texts(as_list(product.get("benefits")), 10)
    effects = _select_high_value_evidence_texts(as_list(product.get("effects")), 10)
    ingredients = _select_high_value_evidence_texts(as_list(product.get("ingredients")), 10)
    usage = _select_high_value_evidence_texts(as_list(product.get("usage")), 10)
    metrics = _select_high_value_evidence_texts(as_list(product.get("metrics")), 10)
    faq_membership, _ = _faq_membership_for_entities(request, _records(faq_node.get("mainEntity") if faq_node else None))
    faq_items = _faq_payload_items(faq_node, faq_membership)
    product_faq = [_copy_faq_item(item) for item in as_list(product.get("faq"))[:12] if as_dict(item)]
    strategic = [_copy_rag_guidance(chunk) for chunk in _select_strategic_rag_chunks(rag_chunks, 8)]
    best_practice = [_copy_rag_guidance(chunk) for chunk in rag_chunks if chunk.get("kind") == "best-practice"][:2]
    static = _COPY_REFINEMENT_STATIC
    descriptions = {
        key: value
        for key, value in (
            ("webPage", _schema_description(markup, "WebPage")),
            ("product", _schema_description(markup, "Product")),
        )
        if value
    }
    current_copy = {
        "schemaDescriptions": descriptions,
        "schemaProperties": _schema_properties(product_node),
        "faqAnswers": faq_items,
        "contentSections": {field: sections[field] for field in ("description", "quickFacts", "faq") if field in sections},
    }
    review = as_dict(product.get("reviews"))
    description_evidence = cast(Mapping[str, object], static["descriptionEvidence"])
    product_evidence: dict[str, object] = {
        **{field: product[field] for field in ("name", "originalName", "brand", "category") if field in product},
        "benefits": benefits,
        "effects": effects,
        "ingredients": ingredients,
        "usage": usage,
        "metrics": metrics,
        "faq": product_faq,
        "reviewSummary": {
            **{field: review[field] for field in ("rating", "reviewCount") if field in review},
            "keywords": _select_high_value_evidence_texts(as_list(review.get("keywords")), 10),
            "examples": _select_high_value_evidence_texts(
                [
                    item.get("body")
                    for item in (as_dict(raw) for raw in as_list(review.get("items")))
                    if isinstance(item.get("body"), str) and not is_volume_or_label_only_review_text(item["body"])
                ],
                5,
            ),
        },
        "sourceTexts": source_texts,
    }
    payload: dict[str, object] = {"task": static["task"]}
    checklist = format_policy_checklist_payload(policy_rules)
    if checklist is not None:
        payload["policyChecklist"] = checklist
    if "locale" in request:
        payload["locale"] = request["locale"]
    if "market" in request:
        payload["market"] = request["market"]
    payload.update(
        {
        "currentCopy": current_copy,
        "productEvidence": product_evidence,
        "descriptionEvidence": {
            **description_evidence,
            "sourceBackedFaq": product_faq,
            "semanticMetricClaims": [_copy_metric_claim(item) for item in as_list(semantic.get("metricClaims"))[:8] if as_dict(item)],
            "ingredientBenefitLinks": [_copy_ingredient_link(item) for item in as_list(semantic.get("ingredientBenefitLinks"))[:8] if as_dict(item)],
            "semanticCitations": [_copy_citation(item) for item in as_list(semantic.get("citations"))[:6] if as_dict(item)],
            "safetyTests": _select_high_value_evidence_texts(as_list(semantic.get("safetyTests")), 12),
            "evidenceSentences": _select_high_value_evidence_texts(as_list(semantic.get("evidenceSentences")), 10),
            "highValueSourceTexts": source_texts,
        },
        "fieldRoleContracts": static["fieldRoleContracts"],
        "fieldSeparatedEvidence": {
            "targetCustomerEvidence": _copy_target_customer_evidence(product, semantic),
            "ingredientTechnologyEvidence": _copy_ingredient_technology_evidence(product, semantic),
            "usageDirections": _copy_usage_directions(product, semantic, graph),
            "pageElementAvailability": {
                "hasFaq": bool(faq_items),
                "hasHowTo": bool(_howto_steps(graph)),
                "hasOffer": _find_node(graph, "Offer") is not None or bool(product.get("price")),
                "hasReportedResults": bool(as_list(product.get("metrics"))) or bool(as_list(semantic.get("metricClaims"))),
                "hasReviews": bool(as_list(as_dict(product.get("reviews")).get("items")))
                or bool(as_dict(product.get("reviews")).get("reviewCount")),
            },
            **cast(Mapping[str, object], static["fieldSeparatedEvidence"]),
        },
        "extractionPriorities": static["extractionPriorities"],
        "publicCopyQualityGate": static["publicCopyQualityGate"],
        "bestPracticeToneGuidance": best_practice,
        "toneApplicationPolicy": static["toneApplicationPolicy"],
        "strategicExposureGuidance": strategic,
        "strategicFullDocuments": [_copy_hydrated_rag_document(item) for item in as_list(request.get("hydratedRagDocuments")) if as_dict(item)],
        "hydrationPolicy": static["hydrationPolicy"],
        "ragGuidance": [
            {**_copy_rag_guidance(chunk), "priority": "strategic" if _is_strategic_copy_chunk(chunk) else "supporting"}
            for chunk in rag_chunks[:8]
        ],
        }
    )
    if isinstance(request.get("reasoning"), Mapping):
        payload["reasoning"] = _copy_reasoning(as_dict(request.get("reasoning")))
    recap = format_policy_compliance_recap(policy_rules)
    if recap is not None:
        payload["complianceRecap"] = recap
    payload["generativeQueryIntents"] = _copy_query_intents(request)
    if request.get("refinementFeedback") is not None:
        payload["refinementFeedback"] = _copy_refinement_feedback(request)
    return payload


def _compact_evidence(values: Sequence[object], limit: int) -> list[str]:
    return _select_high_value_evidence_texts(values, limit)


def _copy_clean_text(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+([,.!?;:])", r"\1", re.sub(r"\s+", " ", re.sub(r"```(?:json)?", "", value, flags=re.I))).strip()


def _copy_truncate(value: object, maximum: int) -> str:
    text = _copy_clean_text(value)
    return text if js_code_unit_length(text) <= maximum else f"{js_utf16_slice(text, 0, max(0, maximum - 1)).strip()}..."


def _copy_evidence_score(value: str) -> int:
    score = 0
    if re.search(r"[0-9０-９]", value):
        score += 6
    if re.search(r"%|배|\b(?:weeks?|days?|hours?|participants?|women|men|subjects?|reviews?)\b|명|인|주|일|시간", value, re.I):
        score += 7
    if re.search(r"(?:임상|인체\s*적용|자가\s*평가|시험|테스트|결과|개선|지속|만족|clinical|study|self[-\s]?assessment|instrumental|result|improvement|agreed)", value, re.I):
        score += 6
    if re.search(r"(?:성분|기술|포뮬러|BotanicalComplex|펩타이드|비타민|콜라겐|레티놀|ingredient|technology|formula|peptide|vitamin|collagen|retinol|ginseng)", value, re.I):
        score += 5
    if re.search(r"(?:보습|수분|탄력|주름|피부결|장벽|진정|리프팅|밀도|hydration|firming|wrinkle|texture|barrier|soothing|lifting|density)", value, re.I):
        score += 5
    if re.search(r"(?:사용|아침|저녁|루틴|단계|apply|use|routine|morning|night)", value, re.I):
        score += 2
    return score


def _select_high_value_evidence_texts(values: Sequence[object], limit: int) -> list[str]:
    ranked = sorted((_copy_clean_text(value) for value in values), key=_copy_evidence_score, reverse=True)
    result: list[str] = []
    for value in ranked:
        if js_code_unit_length(value) < 4 or value in result:
            continue
        result.append(_copy_truncate(value, 520))
        if len(result) >= limit:
            break
    return result


def _copy_faq_item(value: object) -> dict[str, str]:
    item = as_dict(value)
    return {"question": _copy_truncate(item.get("question"), 220), "answer": _copy_truncate(item.get("answer"), 900)}


def _copy_optional_record(value: object, fields: Sequence[str], *, truncate_fields: frozenset[str] = frozenset()) -> dict[str, object]:
    row = as_dict(value)
    result: dict[str, object] = {}
    for field in fields:
        if field not in row:
            continue
        item = row[field]
        if field in truncate_fields:
            if not item:
                continue
            result[field] = _copy_truncate(item, 520)
        else:
            result[field] = item
    return result


def _copy_metric_claim(value: object) -> dict[str, object]:
    return _copy_optional_record(
        value,
        (
            "label",
            "subject",
            "value",
            "unit",
            "metric",
            "direction",
            "timing",
            "baseline",
            "comparator",
            "period",
            "sample",
            "method",
            "institution",
            "evidenceGroup",
            "caveat",
            "sentence",
            "sourceText",
        ),
        truncate_fields=frozenset({"sentence", "sourceText"}),
    )


def _copy_ingredient_link(value: object) -> dict[str, object]:
    return _copy_optional_record(
        value,
        ("ingredient", "benefit", "effect", "sentence", "sourceText"),
        truncate_fields=frozenset({"sentence", "sourceText"}),
    )


def _copy_citation(value: object) -> dict[str, object]:
    return _copy_optional_record(
        value,
        ("type", "title", "publisher", "author", "publishedAt", "url", "finding", "sourceText"),
        truncate_fields=frozenset({"sourceText"}),
    )


def _copy_target_customer_evidence(product: Mapping[str, Any], semantic: Mapping[str, Any]) -> list[str]:
    source = [product.get("description"), *as_list(semantic.get("skinTypes")), *as_list(product.get("benefits")), *as_list(product.get("effects"))]
    source.extend(
        value
        for value in as_list(product.get("sourceTexts"))
        if isinstance(value, str)
        and re.search(r"민감|건조|장벽|수분|보습|노화|안티에이징|주름|탄력|sensitive|dry|barrier|hydration|moisture|aging|anti[-\s]?aging|wrinkle|firm", value, re.I)
    )
    return _select_high_value_evidence_texts(source, 8)


def _copy_ingredient_technology_evidence(product: Mapping[str, Any], semantic: Mapping[str, Any]) -> list[str]:
    links = [as_dict(item) for item in as_list(semantic.get("ingredientBenefitLinks")) if as_dict(item)]
    source = [*as_list(product.get("ingredients")), *as_list(semantic.get("ingredients"))]
    source.extend(value for link in links for value in (link.get("sentence"), link.get("sourceText")) if isinstance(value, str))
    source.extend(
        value
        for value in as_list(product.get("sourceTexts"))
        if isinstance(value, str)
        and re.search(r"성분|기술|포뮬러|복합체|캡슐|특허|세라마이드|히알루론산|레티놀|펩타이드|ingredient|technology|formula|complex|capsule|patent|ceramide|hyaluronic|retinol|peptide", value, re.I)
    )
    return _select_high_value_evidence_texts(source, 10)


def _copy_usage_directions(product: Mapping[str, Any], semantic: Mapping[str, Any], graph: Sequence[dict[str, Any]]) -> list[str]:
    source = [*as_list(product.get("usage")), *as_list(semantic.get("usageSteps")), *_howto_steps(graph)]
    source.extend(
        value
        for value in as_list(product.get("sourceTexts"))
        if isinstance(value, str) and is_procedural_usage_instruction(value)
    )
    return _select_high_value_evidence_texts(source, 8)


def _is_strategic_copy_chunk(chunk: Mapping[str, Any]) -> bool:
    kind = str(chunk.get("kind"))
    return kind in _STRATEGIC_RAG_KINDS or bool(
        re.search(r"geo[-_\s]?(research|paper)|generative|cep|customer entry point|e-e-a-t|eeat", f"{chunk.get('source')} {chunk.get('title') or ''}", re.I)
    )


def _select_strategic_rag_chunks(chunks: Sequence[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    strategic = [chunk for chunk in chunks if _is_strategic_copy_chunk(chunk)]
    selected: list[dict[str, Any]] = []
    seen: set[str] = set()
    for kind in _STRATEGIC_RAG_KIND_ORDER:
        candidate = next((chunk for chunk in strategic if chunk.get("kind") == kind), None)
        if candidate is not None:
            selected.append(candidate)
            seen.add(f"{candidate.get('source')}:{candidate.get('title') or ''}:{candidate.get('id')}")
    for chunk in strategic:
        if len(selected) >= limit:
            break
        key = f"{chunk.get('source')}:{chunk.get('title') or ''}:{chunk.get('id')}"
        if key not in seen:
            selected.append(chunk)
            seen.add(key)
    return selected


def _copy_rag_guidance(chunk: Mapping[str, Any]) -> dict[str, object]:
    metadata = as_dict(chunk.get("metadata"))
    result: dict[str, object] = {field: chunk[field] for field in ("source", "title") if field in chunk}
    if isinstance(metadata.get("headingPath"), str):
        result["headingPath"] = metadata["headingPath"]
    if "kind" in chunk:
        result["kind"] = chunk["kind"]
    result["intents"] = chunk.get("intents") if chunk.get("intents") is not None else []
    result["fieldTargets"] = chunk.get("fieldTargets") if chunk.get("fieldTargets") is not None else []
    if "score" in chunk:
        result["score"] = chunk["score"]
    result["excerpt"] = _copy_truncate(chunk.get("text"), 700)
    return result


def _copy_hydrated_rag_document(value: object) -> dict[str, object]:
    document = as_dict(value)
    content = _copy_clean_text(document.get("content"))
    return {
        **{
            field: document[field]
            for field in ("source", "version", "kind", "hydrationMode", "selectedChunkTitles")
            if field in document
        },
        "content": _copy_truncate(content, 8000),
        "contentTruncated": js_code_unit_length(content) > 8000,
    }


def _copy_query_intents(request: Mapping[str, Any]) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    for value in as_list(request.get("inferredSearchQueries"))[:8]:
        query = as_dict(value)
        if not query:
            continue
        result.append(
            {
                "kind": query.get("kind"),
                "question": query.get("question"),
                "keywords": query.get("keywords"),
                "mentionsProductOrBrand": query.get("mentionsProductOrBrand"),
                "evidenceStatus": "query-hypothesis-only",
                "allowedUse": "Intent discovery only; every context and answer fact used publicly must be independently supported by productEvidence.",
            }
        )
    return result


def _copy_reasoning(reasoning: Mapping[str, Any]) -> dict[str, object]:
    return {
        "principles": reasoning.get("principles"),
        "selectedSources": reasoning.get("selectedSources"),
        "decisions": [
            {
                "principle": item.get("principle"),
                "enabled": item.get("enabled"),
                "confidence": item.get("confidence"),
                "rationale": item.get("rationale"),
                "ragSources": item.get("ragSources"),
                "productEvidence": item.get("productEvidence"),
            }
            for item in (as_dict(raw) for raw in as_list(reasoning.get("decisions")))
            if item
        ],
    }


def _copy_refinement_feedback(request: Mapping[str, Any]) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    for value in as_list(request.get("refinementFeedback")):
        item = as_dict(value)
        feedback: dict[str, object] = {field: item[field] for field in ("field", "reason") if field in item}
        if item.get("rejectedText"):
            feedback["rejectedText"] = _copy_truncate(item.get("rejectedText"), 520)
        if item.get("currentText"):
            feedback["currentText"] = _copy_truncate(item.get("currentText"), 520)
        result.append(feedback)
    return result


def _schema_properties(product: Mapping[str, Any] | None) -> dict[str, str]:
    if product is None:
        return {}
    return {
        item["name"]: item["value"]
        for item in _records(product.get("additionalProperty"))
        if isinstance(item.get("name"), str) and isinstance(item.get("value"), str)
    }


def _faq_payload_items(
    faq: Mapping[str, Any] | None, membership: Sequence[Mapping[str, Any]] | None = None
) -> list[dict[str, object]]:
    if faq is None:
        return []
    entities = _records(faq.get("mainEntity"))
    if membership is not None and len(membership) != len(entities):
        return []
    rows: list[dict[str, object]] = []
    for index, item in enumerate(entities):
        answer = as_dict(item.get("acceptedAnswer"))
        question = item.get("name")
        text = answer.get("text")
        if question and text:
            row: dict[str, object] = {"question": question, "answer": text}
            if membership is not None:
                identifier = clean_text(as_dict(membership[index]).get("id"))
                if not identifier:
                    return []
                row["id"] = identifier
            rows.append(row)
    return rows


def _howto_steps(graph: Sequence[dict[str, Any]]) -> list[str]:
    howto = _find_node(graph, "HowTo")
    return _compact_evidence(
        [item.get("text") or item.get("name") for item in _records(howto.get("step") if howto else None)], 8
    )


pdp_geo_copy_refinement_json_schema: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "schemaDescriptions": {
            "type": "object",
            "additionalProperties": False,
            "properties": {"webPage": {"type": "string"}, "product": {"type": "string"}},
        },
        "schemaProperties": {"type": "object", "additionalProperties": {"type": "string"}},
        "faqAnswers": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {"id": {"type": "string"}, "question": {"type": "string"}, "answer": {"type": "string"}},
                "required": ["id", "question", "answer"],
            },
        },
        "contentSections": {"type": "object"},
        "ruleCompliance": {"type": "object"},
        "warnings": {"type": "array", "items": {"type": "string"}},
    },
}


def is_volume_or_label_only_review_text(value: str) -> bool:
    """Reject a review payload that is only a size/volume artifact."""

    text = clean_proposed_text(value)
    if not re.search(r"\d", text):
        return False
    stripped = re.sub(r"\d+(?:\.\d+)?\s*(?:fl\.?\s*oz\.?|m[lL]|g|kg|ea|oz)\b", " ", text, flags=re.I)
    stripped = re.sub(r"[\d\s.,/×xX*+·-]+", " ", stripped).strip()
    return len(stripped) < 4


def refinement_drops_published_measurement(
    field: str, refined: str, composed: str, request: Mapping[str, Any]
) -> bool:
    """Guard against a refinement silently removing a published numeric claim.

    The digits of a product's own registered name identify it rather than
    measure anything, so calling the product by name a different number of times
    changes no claim.  What has to survive is the set of measurements the
    approved copy published.
    """

    if not _states_measurement_bound_copy(field):
        return False
    return bool(
        _unstated_measurement_claims(_measurement_claims(composed, request), _measurement_claims(refined, request))
    )


def refinement_states_unpublished_measurement(field: str, refined: str, request: Mapping[str, Any]) -> bool:
    """Guard against a refinement inventing a numeric claim the evidence never made.

    Read from the other side, the same rule closes the hole where copy with no
    prior figure could gain one: a measurement may appear in public copy only
    because the product's own evidence publishes it.
    """

    if not _states_measurement_bound_copy(field):
        return False
    return bool(
        _unstated_measurement_claims(_measurement_claims(refined, request), _published_measurement_claims(request))
    )


def _states_measurement_bound_copy(field: str) -> bool:
    return "description" in field.casefold() or "reported" in field.casefold()


def _measurement_claims(value: str, request: Mapping[str, Any]) -> set[str]:
    """Return the numerics that measure something rather than name the product."""
    return set(numeric_tokens(value)) - naming_identifier_numerics(value, _product_naming_surfaces(request))


def _unstated_measurement_claims(claims: Iterable[str], stated: Iterable[str]) -> set[str]:
    """Return the claims no stated measurement carries at the same magnitude and direction.

    ``+5.9%`` and ``5.9%`` are one measurement written two ways: an ordinary
    rewrite moves the direction out of the sign and into the verb, and counting
    that as a different figure discards good copy.  ``+5.9%`` and ``-5.9%`` are
    not one measurement, so a matching magnitude does not satisfy a claim whose
    direction the other side reversed.
    """
    stated_claims = list(stated)
    return {claim for claim in claims if not any(_states_one_measurement(token, claim) for token in stated_claims)}


def _states_one_measurement(stated: str, claim: str) -> bool:
    return _measurement_magnitude(stated) == _measurement_magnitude(claim) and not _reverses_measurement_direction(
        stated, claim
    )


def _measurement_magnitude(value: str) -> str:
    return _MEASUREMENT_SIGN.sub("", value, count=1)


def _reverses_measurement_direction(stated: str, claim: str) -> bool:
    signs = {_measurement_direction(stated), _measurement_direction(claim)}
    return "+" in signs and "-" in signs


def _measurement_direction(value: str) -> str:
    match = _MEASUREMENT_SIGN.match(value)
    return match.group(0).replace("−", "-") if match else ""


def _published_measurement_claims(request: Mapping[str, Any]) -> set[str]:
    """Return every measurement the product's own evidence publishes."""
    product = as_dict(request.get("product"))
    semantic = as_dict(product.get("semanticFacts"))
    published = " ".join(
        [
            clean_text(product.get("description")),
            *[clean_text(item) for item in as_list(product.get("metrics"))],
            *[clean_text(item) for item in as_list(product.get("benefits"))],
            *[clean_text(item) for item in as_list(product.get("effects"))],
            *[clean_text(item) for item in as_list(product.get("sourceTexts"))],
            *[clean_text(item) for item in as_list(semantic.get("evidenceSentences"))],
            *[
                clean_text(as_dict(item).get(key))
                for item in as_list(semantic.get("metricClaims"))
                for key in ("value", "unit", "sentence", "sourceText", "sample", "period")
            ],
            *[
                clean_text(entry)
                for item in as_list(product.get("faq"))
                for entry in (as_dict(item).get("question"), as_dict(item).get("answer"))
            ],
            str(as_dict(request.get("content")).get("sections") or ""),
        ]
    )
    return _measurement_claims(published, request)


def _product_naming_surfaces(request: Mapping[str, Any]) -> list[str]:
    """Return the designations the product and its formula are called by."""
    product = as_dict(request.get("product"))
    semantic = as_dict(product.get("semanticFacts"))
    return [
        value
        for value in _unique_clean_texts(
            [
                *product_naming_surfaces(product),
                *as_list(product.get("ingredients")),
                *(as_dict(item).get("ingredient") for item in as_list(semantic.get("ingredientBenefitLinks"))),
            ]
        )
        if _names_a_fact(value)
    ]


def _refinement_outcome(applied: Mapping[str, Any]) -> str:
    """Name what the model's copy came to, so a reader never confuses it with a failure."""
    if applied.get("applied") is True:
        return "applied"
    return "rejected" if as_list(applied.get("rejections")) else "unchanged"


def _base_application(input_: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "schemaMarkup": as_dict(input_.get("schemaMarkup")),
        "content": as_dict(input_.get("content")),
        "faqMembership": copy.deepcopy(as_list(input_.get("faqMembership"))),
        "evidence": [],
        "warnings": [],
        "called": False,
        "applied": False,
        "rejections": [],
        "modelCall": _model_call("notCalled", called=False),
    }


def _collect_retry_targets(applied: Mapping[str, Any], request: Mapping[str, Any]) -> list[dict[str, str]]:
    """Return rejected or still-unsafe adopted fields exactly once per field.

    A provider can omit a malformed existing description entirely.  The
    corrective pass must still see that residual public artifact rather than
    treating an empty model response as a successful no-op.
    """

    feedback: list[dict[str, str]] = []
    for item in as_list(applied.get("rejections")):
        row = as_dict(item)
        field = clean_text(row.get("field"))
        reason = clean_text(row.get("reason"))
        if field and reason:
            feedback.append(
                {
                    "field": field,
                    "reason": reason,
                    **({"rejectedText": clean_text(row.get("rejectedText"))} if row.get("rejectedText") else {}),
                    **({"currentText": clean_text(row.get("currentText"))} if row.get("currentText") else {}),
                }
            )
    markup = as_dict(applied.get("schemaMarkup"))
    content = as_dict(applied.get("content"))
    sections = as_dict(content.get("sections"))
    final_texts = (
        ("Product.description", _schema_description(markup, "Product")),
        ("WebPage.description", _schema_description(markup, "WebPage")),
        ("content.sections.description", clean_text(sections.get("description"))),
    )
    for field, value in final_texts:
        if not value:
            continue
        if _contains_analysis_label(value):
            feedback.append(
                {
                    "field": field,
                    "reason": "the current adopted text still exposes an internal analysis label such as 평가 지표:; "
                    "rewrite the measured result as a natural product sentence with a supported predicate.",
                    "currentText": value,
                }
            )
        elif _contains_disallowed_raw_volume_fragment(field, value, request):
            feedback.append(
                {
                    "field": field,
                    "reason": "the current adopted text contains a bare or misplaced volume/size string; keep "
                    "Product.description size-free and use size in WebPage.description only inside a matching "
                    "option-and-offer sentence.",
                    "currentText": value,
                }
            )
    seen: set[str] = set()
    return [item for item in feedback if not (item["field"] in seen or seen.add(item["field"]))]


def _schema_description(markup: Mapping[str, Any], kind: str) -> str:
    json_ld = as_dict(markup.get("jsonLd"))
    for node in _records(json_ld.get("@graph")):
        types = node.get("@type")
        if types == kind or isinstance(types, list) and kind in types:
            return clean_text(node.get("description"))
    return ""


def _contains_analysis_label(value: str) -> bool:
    return bool(_ANALYSIS_LABEL.search(value) or has_analysis_label_artifact(value))


def _split_public_sentences(value: str) -> list[str]:
    return [sentence.strip() for sentence in re.split(r"(?<=[.!?。！？])\s+", value) if sentence.strip()]


def _contains_disallowed_raw_volume_fragment(field: str, value: str, request: Mapping[str, Any]) -> bool:
    if not _states_foreign_volume(value, request):
        return False
    if field != "WebPage.description":
        return True
    return any(
        _states_foreign_volume(sentence, request) and not _WEBPAGE_VOLUME_CONTEXT.search(sentence)
        for sentence in _split_public_sentences(value)
    )


def _states_foreign_volume(value: str, request: Mapping[str, Any]) -> bool:
    """Return whether a size string names a volume the product is not sold in.

    A registered name such as ``BarrierCare365 클렌징폼 200g`` carries its size as
    part of what the product is called, so quoting the name is not a loose
    measurement.  Any other size string still is one.
    """
    identifiers = naming_identifier_numerics(value, _product_naming_surfaces(request))
    return any(not set(numeric_tokens(match.group(0))) <= identifiers for match in _RAW_VOLUME.finditer(value))


def _strategic_exposure_source_summary(request: Mapping[str, Any]) -> str:
    values: list[str] = []
    for item in as_list(request.get("ragChunks")):
        row = as_dict(item)
        metadata = as_dict(row.get("metadata"))
        kind = clean_text(row.get("kind")) or clean_text(metadata.get("kind"))
        if kind not in {"geo-research", "geo-paper", "cep", "eeat"}:
            continue
        source = (
            clean_text(row.get("source"))
            or clean_text(row.get("title"))
            or clean_text(row.get("name"))
            or clean_text(row.get("document"))
            or clean_text(metadata.get("source"))
            or clean_text(metadata.get("title"))
            or clean_text(metadata.get("name"))
        )
        if source and source not in values:
            values.append(source)
    return ", ".join(values[:8])


def _resolve_refiner(runtime: Mapping[str, Any]) -> tuple[object | None, str | None]:
    custom = runtime.get("customCopyRefiner")
    if custom is not None:
        return custom, None
    settings = as_dict(runtime.get("copyRefinement"))
    if settings.get("enabled") is False:
        return None, None
    inherited_provider = clean_text(runtime.get("provider"))
    configured_provider = clean_text(settings.get("provider"))
    provider = configured_provider or inherited_provider or "mock"
    may_inherit_provider_settings = not configured_provider or configured_provider == inherited_provider
    api_key = settings.get("apiKey")
    if api_key is None and may_inherit_provider_settings:
        api_key = runtime.get("apiKey")
    explicit_enabled = settings.get("enabled")
    enabled = explicit_enabled if isinstance(explicit_enabled, bool) else provider not in {"mock", "custom"} and bool(api_key)
    if not enabled:
        return None, None
    if provider in {"mock", "custom"}:
        return None, f"{provider} copy refinement requires customCopyRefiner."
    deployments = as_dict(runtime.get("deployments"))

    def configured_or_inherited(key: str, fallback: object = None) -> object:
        configured = settings.get(key)
        if configured is not None:
            return configured
        return runtime.get(key, fallback) if may_inherit_provider_settings else fallback

    timeout_seconds = configured_or_inherited("timeoutSeconds")
    if timeout_seconds is None:
        timeout_seconds = configured_or_inherited("timeout_seconds")

    return (
        ModelBackedCopyRefiner(
            {
                "provider": provider,
                "apiKey": api_key,
                "model": configured_or_inherited("model"),
                "endpoint": configured_or_inherited("endpoint"),
                "deployment": configured_or_inherited(
                    "deployment", deployments.get("reasoning") or runtime.get("deployment")
                ),
                "apiVersion": configured_or_inherited("apiVersion"),
                "temperature": runtime.get("temperature"),
                "timeoutSeconds": timeout_seconds,
            }
        ),
        None,
    )


def resolve_copy_refiner(runtime: Mapping[str, Any]) -> tuple[object | None, str | None]:
    """Expose the provider-inheritance resolver without leaking a private API."""

    return _resolve_refiner(runtime)


async def _refine(refiner: object, request: Mapping[str, Any]) -> dict[str, Any]:
    method = getattr(refiner, "refine_copy", None) or getattr(refiner, "refineCopy", None)
    if not callable(method):
        raise CopyRefinementContractError("customCopyRefiner must provide refine_copy(request) or refineCopy(request).")
    value = method(request)
    if inspect.isawaitable(value):
        value = await value
    if not isinstance(value, Mapping):
        raise CopyRefinementContractError("Copy refinement response must be a JSON object.")
    return as_dict(cast(object, value))


def _apply_refinement(request: Mapping[str, Any], result: Mapping[str, Any]) -> dict[str, Any]:
    markup = copy.deepcopy(as_dict(request.get("schemaMarkup")))
    content = copy.deepcopy(as_dict(request.get("content")))
    json_ld = as_dict(markup.get("jsonLd"))
    graph_value = json_ld.get("@graph")
    if not isinstance(graph_value, list):
        return {
            "schemaMarkup": markup,
            "content": content,
            "evidence": [],
            "warnings": ["Copy refinement could not locate a JSON-LD @graph."],
            "applied": False,
            "rejections": [],
        }
    graph = _records(cast(object, graph_value))
    json_ld["@graph"] = graph
    product = _find_node(graph, "Product")
    webpage = _find_node(graph, "WebPage")
    sections: dict[str, Any] = as_dict(content.get("sections"))
    content["sections"] = sections
    evidence: list[dict[str, str]] = []
    warnings: list[str] = []
    rejections: list[dict[str, str]] = []
    applied = False
    schema_changed = False
    content_changed = False
    descriptions = as_dict(result.get("schemaDescriptions"))
    content_sections = as_dict(result.get("contentSections"))
    free_form_faq = content_sections.get("faq")
    if isinstance(free_form_faq, str) and clean_text(free_form_faq) != clean_text(sections.get("faq")):
        reason = (
            "content.sections.faq refinement rejected because free-form FAQ section copy cannot be verified item by "
            "item; refine matching FAQPage questions and answers instead."
        )
        warnings.append(reason)
        rejections.append(
            {"field": "content.sections.faq", "reason": reason, "rejectedText": clean_text(free_form_faq)}
        )
    product_candidate = descriptions.get("product") or content_sections.get("description")
    current_product = clean_text(product.get("description")) if product else clean_text(sections.get("description"))
    accepted_product = _accept_text(product_candidate, current_product, "Product.description", request)
    if accepted_product.error:
        warnings.append(accepted_product.error)
        rejections.append(
            {
                "field": "Product.description",
                "reason": accepted_product.error,
                "rejectedText": clean_text(product_candidate),
            }
        )
    content_candidate = content_sections.get("description") or product_candidate
    current_content = clean_text(sections.get("description"))
    accepted_content = _accept_text(content_candidate, current_content, "content.sections.description", request)
    if accepted_content.error:
        warnings.append(accepted_content.error)
        rejections.append(
            {
                "field": "content.sections.description",
                "reason": accepted_content.error,
                "rejectedText": clean_text(content_candidate),
            }
        )
    next_product_description = accepted_product.text or accepted_content.text
    next_content_description = accepted_content.text or accepted_product.text
    if next_product_description and next_product_description != current_product:
        if product is not None:
            product["description"] = next_product_description
        evidence.append(
            {
                "field": "schema.Product.description",
                "source": "llm",
                "value": _summary(current_product, next_product_description),
            }
        )
        applied = True
        schema_changed = True
    if next_content_description and next_content_description != current_content:
        sections["description"] = next_content_description
        evidence.append(
            {
                "field": "content.description",
                "source": "llm",
                "value": _summary(current_content, next_content_description),
            }
        )
        applied = True
        content_changed = True
    web_candidate = descriptions.get("webPage")
    current_web = clean_text(webpage.get("description")) if webpage else ""
    accepted_web = _accept_text(web_candidate, current_web, "WebPage.description", request)
    if accepted_web.error:
        warnings.append(accepted_web.error)
        rejections.append(
            {"field": "WebPage.description", "reason": accepted_web.error, "rejectedText": clean_text(web_candidate)}
        )
    elif accepted_web.text and accepted_web.text != current_web and webpage is not None:
        webpage["description"] = accepted_web.text
        evidence.append(
            {"field": "schema.WebPage.description", "source": "llm", "value": _summary(current_web, accepted_web.text)}
        )
        applied = True
        schema_changed = True
    quick_candidate = content_sections.get("quickFacts")
    current_quick = clean_text(sections.get("quickFacts"))
    accepted_quick = _accept_text(quick_candidate, current_quick, "content.sections.quickFacts", request, minimum=1)
    if accepted_quick.error:
        warnings.append(accepted_quick.error)
        rejections.append(
            {
                "field": "content.sections.quickFacts",
                "reason": accepted_quick.error,
                "rejectedText": clean_text(quick_candidate),
            }
        )
    elif accepted_quick.text and accepted_quick.text != current_quick:
        sections["quickFacts"] = accepted_quick.text
        evidence.append(
            {"field": "content.quickFacts", "source": "llm", "value": _summary(current_quick, accepted_quick.text)}
        )
        applied = True
        content_changed = True
    property_changed, property_warnings, property_evidence = _apply_property_refinements(
        product, result, request, rejections
    )
    applied = applied or property_changed
    schema_changed = schema_changed or property_changed
    warnings.extend(property_warnings)
    evidence.extend(property_evidence)
    faq_changed, faq_warnings, faq_evidence = _apply_faq_refinements(graph, result, request, rejections)
    applied = applied or faq_changed
    schema_changed = schema_changed or faq_changed
    warnings.extend(faq_warnings)
    evidence.extend(faq_evidence)
    if faq_changed:
        sections["faq"] = _faq_section(graph)
        content_changed = True
    if content_changed:
        content["html"] = ""
    return {
        "schemaMarkup": serialize_schema_markup(json_ld) if schema_changed else as_dict(request.get("schemaMarkup")),
        "content": content if content_changed else as_dict(request.get("content")),
        "faqMembership": copy.deepcopy(as_list(request.get("faqMembership"))),
        "evidence": evidence,
        "warnings": warnings,
        "applied": applied,
        "rejections": rejections,
    }


class _AcceptedText:
    def __init__(self, text: str | None = None, error: str | None = None) -> None:
        self.text = text
        self.error = error


def _accept_text(
    candidate: object, current: str, field: str, request: Mapping[str, Any], minimum: int = 12
) -> _AcceptedText:
    if candidate is None:
        return _AcceptedText()
    text = clean_proposed_text(str(candidate))
    if not text:
        return _AcceptedText(error=f"{field} refinement rejected because it was empty.")
    if len(text) < minimum or len(text) > 3500:
        return _AcceptedText(
            error=f"{field} refinement rejected because its length was outside the public-copy contract."
        )
    if _contains_analysis_label(text):
        return _AcceptedText(error=f"{field} refinement rejected because it exposes an analysis label.")
    if _contains_disallowed_raw_volume_fragment(field, text, request):
        return _AcceptedText(error=f"{field} refinement rejected because it contains a raw volume string.")
    if field in {"Product.description", "content.sections.description"} and _contains_product_page_language(text):
        return _AcceptedText(
            error=f"{field} refinement rejected because Product descriptions must describe the product entity, not a product page."
        )
    if field in {"Product.description", "content.sections.description", "WebPage.description"} and _contains_concrete_product_usage_step(text):
        return _AcceptedText(
            error=f"{field} refinement rejected because it appends concrete usage directions that belong in Usage or HowTo."
        )
    if field in {"Product.description", "content.sections.description"}:
        role_rejection = _product_description_role_contract_rejection(text, current, request)
        if role_rejection:
            return _AcceptedText(error=f"{field} refinement rejected because {role_rejection}")
        if _introduces_unsupported_context_association(text, request):
            return _AcceptedText(
                error=f"{field} refinement rejected because it promoted an unsupported context association into public copy."
            )
    if field == "WebPage.description" and _are_schema_descriptions_too_similar(
        text, _schema_description(as_dict(request.get("schemaMarkup")), "Product")
    ):
        return _AcceptedText(
            error="WebPage.description refinement rejected because it repeats Product.description instead of describing page-level coverage."
        )
    if field == "WebPage.description":
        web_page_rejection = _webpage_description_contract_rejection(text, current, request)
        if web_page_rejection:
            return _AcceptedText(error=f"{field} refinement rejected because {web_page_rejection}")
    if field in {"Product.description", "content.sections.description", "WebPage.description"}:
        relation_rejection = _unsupported_ingredient_benefit_relation_rejection(text, current, request)
        if relation_rejection:
            return _AcceptedText(error=f"{field} refinement rejected because {relation_rejection}")
    if _UNSUPPORTED_CLAIM.search(text):
        return _AcceptedText(error=f"{field} refinement rejected because it makes an unsupported strong claim.")
    if refinement_drops_published_measurement(field, text, current, request):
        return _AcceptedText(error=f"{field} refinement rejected because it drops a published measurement.")
    if refinement_states_unpublished_measurement(field, text, request):
        return _AcceptedText(
            error=f"{field} refinement rejected because it states a measurement the product evidence does not publish."
        )
    if not _is_source_supported(text, request, current):
        return _AcceptedText(
            error=f"{field} refinement rejected because its factual tokens were not supported by the product evidence."
        )
    return _AcceptedText(text=text)


def _contains_product_page_language(value: str) -> bool:
    return re.search(
        r"(?:\b(?:product\s+(?:detail\s+)?page|pdp)\b|\bproduct\s+page\b|상품\s*페이지|제품\s*페이지|상세\s*페이지|商品ページ|製品ページ)",
        value,
        re.I,
    ) is not None


def _contains_concrete_product_usage_step(value: str) -> bool:
    return any(is_procedural_usage_instruction(sentence) for sentence in _split_public_sentences(value))


def _product_description_role_contract_rejection(text: str, base: str, request: Mapping[str, Any]) -> str | None:
    """Retain the ordered buyer-answer roles that the approved base actually contains."""

    if _find_product_identity_position(base, request) >= 0 and _find_product_identity_position(text, request) < 0:
        return "it no longer identifies the product entity present in the approved base description."

    relation_rejection = _unsupported_ingredient_benefit_relation_rejection(text, base, request)
    if relation_rejection:
        return relation_rejection

    requirements = _product_description_role_requirements(base, request)
    cursor = -1
    for role, facts in requirements:
        if role == "introduction":
            position = _find_product_identity_position(text, request, cursor)
        elif role == "attributed review":
            position = _find_review_attribution_position(text, cursor)
        else:
            position = _find_fact_position(text, facts, cursor, request)
        if position < 0:
            return f"it dropped or reordered the approved {role} role."
        cursor = position
    if any(role == "attributed review" for role, _ in requirements) and not _review_attribution_is_last(text):
        return "the source-backed customer-review summary is not the final Product.description role."
    return None


def _product_description_role_requirements(
    base: str, request: Mapping[str, Any]
) -> list[tuple[str, list[str]]]:
    """Return only roles that have a source anchor in the approved base copy."""

    product = as_dict(request.get("product"))
    semantic = as_dict(product.get("semanticFacts"))
    markup = as_dict(request.get("schemaMarkup"))
    product_node = _find_node(_records(as_dict(markup.get("jsonLd")).get("@graph")), "Product")
    properties = _schema_properties(product_node)
    links = [as_dict(item) for item in as_list(semantic.get("ingredientBenefitLinks")) if as_dict(item)]
    metric_claims = [as_dict(item) for item in as_list(semantic.get("metricClaims")) if as_dict(item)]
    target_facts = _unique_clean_texts(
        [
            *as_list(semantic.get("skinTypes")),
            properties.get("Target customer", ""),
            *_extract_target_role_fragments(base),
        ]
    )
    ingredient_facts = _unique_clean_texts(
        [
            *as_list(product.get("ingredients")),
            *as_list(semantic.get("ingredients")),
            *(link.get("ingredient") for link in links),
        ]
    )
    benefit_facts = _unique_clean_texts(
        [
            *as_list(product.get("benefits")),
            *as_list(product.get("effects")),
            *as_list(semantic.get("benefits")),
            *as_list(semantic.get("effects")),
            *(link.get("benefit") for link in links),
            *(link.get("effect") for link in links),
            *(claim.get(field) for claim in metric_claims for field in ("label", "metric", "subject", "sentence")),
        ]
    )
    review_facts = _source_backed_review_facts(request)
    requirements: list[tuple[str, list[str]]] = []
    if _find_product_identity_position(base, request) >= 0:
        requirements.append(("introduction", []))
    if _find_fact_position(base, target_facts, -1, request) >= 0:
        requirements.append(("target customer/concern", target_facts))
    if _find_fact_position(base, ingredient_facts, -1, request) >= 0:
        requirements.append(("ingredient/formula", ingredient_facts))
    if _find_fact_position(base, benefit_facts, -1, request) >= 0:
        requirements.append(("benefit/effect", benefit_facts))
    if _find_review_attribution_position(base, -1) >= 0 and _find_fact_position(base, review_facts, -1, request) >= 0:
        requirements.append(("attributed review", review_facts))
    return requirements


def _find_fact_position(
    value: str, facts: Sequence[str], after: int, request: Mapping[str, Any] | None = None
) -> int:
    comparable = _compact_comparable_text(value)
    positions: list[int] = []
    for fact in facts:
        fact_tokens = _role_fact_tokens(fact, request)
        if not fact_tokens:
            continue
        candidates = ["".join(fact_tokens)]
        if len(fact_tokens) >= 2:
            candidates.extend(
                "".join(fact_tokens[index : index + 2]) for index in range(len(fact_tokens) - 1)
            )
        positions.extend(
            comparable.find(candidate, after + 1)
            for candidate in candidates
            if len(candidate) >= 2 and comparable.find(candidate, after + 1) >= 0
        )
    return min(positions, default=-1)


def _role_fact_tokens(fact: object, request: Mapping[str, Any] | None) -> list[str]:
    tokens = [_compact_comparable_text(token) for token in _meaningful_answer_tokens(clean_text(fact))]
    if request is None:
        return [token for token in tokens if token]
    identity_tokens = {
        _compact_comparable_text(token)
        for token in _meaningful_answer_tokens(
            " ".join(
                clean_text(as_dict(request.get("product")).get(field))
                for field in ("name", "originalName", "brand")
            )
        )
    }
    return [token for token in tokens if token and not any(_shares_stem(token, identity) for identity in identity_tokens)]


def _compact_comparable_text(value: object) -> str:
    return _comparable_text(clean_text(value)).replace(" ", "")


def _find_product_identity_position(value: str, request: Mapping[str, Any], after: int = -1) -> int:
    product = as_dict(request.get("product"))
    comparable = _compact_comparable_text(value)
    names = _unique_clean_texts([product.get("name"), product.get("originalName")])
    positions = [
        comparable.find(_compact_comparable_text(name), after + 1)
        for name in names
        if len(_compact_comparable_text(name)) >= 3
    ]
    exact = min((position for position in positions if position >= 0), default=-1)
    if exact >= 0:
        return exact
    brand = _compact_comparable_text(product.get("brand"))
    identity_tokens = sorted(
        {
            _compact_comparable_text(token)
            for token in _meaningful_answer_tokens(f"{product.get('name', '')} {product.get('originalName', '')}")
            if len(_compact_comparable_text(token)) >= 3 and _compact_comparable_text(token) != brand
        },
        key=len,
        reverse=True,
    )[:4]
    return min(
        (comparable.find(token, after + 1) for token in identity_tokens if comparable.find(token, after + 1) >= 0),
        default=-1,
    )


def _source_backed_review_facts(request: Mapping[str, Any]) -> list[str]:
    reviews = as_dict(as_dict(request.get("product")).get("reviews"))
    return _unique_clean_texts(
        [
            *as_list(reviews.get("keywords")),
            *(
                clean_text(as_dict(item).get("body"))
                for item in as_list(reviews.get("items"))
                if not is_volume_or_label_only_review_text(clean_text(as_dict(item).get("body")))
            ),
        ]
    )


def _find_review_attribution_position(value: str, after: int) -> int:
    pattern = re.compile(
        r"customer\s+reviews?|customers?\s+(?:say|mention|report|describe)|user\s+reviews?|reviewers?|"
        r"고객\s*리뷰|고객들은|사용자들은|리뷰에서는|리뷰에\s*따르면|후기에서는|후기에는|口コミ|レビューでは",
        re.I,
    )
    return next((match.start() for match in pattern.finditer(_comparable_text(value)) if match.start() > after), -1)


def _review_attribution_is_last(value: str) -> bool:
    sentences = _split_public_sentences(value)
    return bool(sentences) and _find_review_attribution_position(sentences[-1], -1) >= 0


def _extract_target_role_fragments(value: str) -> list[str]:
    fragments: list[str] = []
    for sentence in _split_public_sentences(value):
        korean_for = re.search(r"(.{2,90}?)(?:을|를)\s*위한", sentence)
        if korean_for:
            fragments.append(re.split(r"(?:은|는|,|;)", korean_for.group(1))[-1])
        korean_fit = re.search(r"(.{2,90}?)(?:에게|에)\s*(?:적합|추천|권장)", sentence)
        if korean_fit:
            fragments.append(re.split(r"(?:은|는|,|;)", korean_fit.group(1))[-1])
        english = re.search(r"\bfor\s+([^,.!?;]{2,100})", sentence, re.I)
        if english:
            fragments.append(re.split(r"\b(?:with|who|that|seeking)\b", english.group(1), flags=re.I)[0])
        japanese = re.search(r"([^。！？、]{2,90})(?:向け|のため)", sentence)
        if japanese:
            fragments.append(re.split(r"(?:は|、)", japanese.group(1))[-1])
    return _unique_clean_texts(
        re.sub(r"^(?:and|or|또는|및)\s+", "", fragment, flags=re.I) for fragment in fragments if len(fragment.strip()) >= 3
    )


def _unique_clean_texts(values: Iterable[object]) -> list[str]:
    result: list[str] = []
    for value in values:
        text = clean_text(value)
        if text and text not in result:
            result.append(text)
    return result


_SOURCE_REQUIRED_CONTEXTS = (
    re.compile(r"\b(?:spring|springtime)\b|봄철?|춘계|春(?:季)?", re.I),
    re.compile(r"\b(?:summer|summertime|hot\s+weather)\b|여름철?|하절기|더운\s*날씨|夏(?:季)?", re.I),
    re.compile(r"\b(?:autumn|autumnal)\b|가을철?|추계|秋(?:季)?", re.I),
    re.compile(r"\b(?:winter|wintertime|cold\s+weather)\b|겨울철?|동절기|추운\s*날씨|冬(?:季)?", re.I),
    re.compile(r"\b(?:morning|night|evening|bedtime|overnight)\b|아침|저녁|취침\s*전|밤사이|朝|夜", re.I),
    re.compile(r"\b(?:after\s+(?:cleansing|washing)|before\s+makeup)\b|세안\s*후|클렌징\s*후|메이크업\s*전", re.I),
    re.compile(r"\b(?:gift|gifting|travel|travelling|traveling|exercise|workout|outdoor)\b|선물|여행|운동|야외", re.I),
)
_SOURCE_REQUIRED_GENERALIZATION = re.compile(
    r"\b(?:generally|typically|usually|commonly|as\s+a\s+rule|in\s+general)\b|일반적으로|대체로|통상적으로|보통은",
    re.I,
)
_SOURCE_REQUIRED_CAUSAL = re.compile(
    r"\b(?:because|because\s+of|due\s+to|caused\s+by|as\s+a\s+result\s+of)\b|때문에|로\s*인해|에서\s*비롯|결과로",
    re.I,
)


def _introduces_unsupported_context_association(text: str, request: Mapping[str, Any]) -> bool:
    product = as_dict(request.get("product"))
    semantic = as_dict(product.get("semanticFacts"))
    corpus = " ".join(
        [
            clean_text(product.get("description")),
            *[clean_text(item) for item in as_list(product.get("benefits"))],
            *[clean_text(item) for item in as_list(product.get("effects"))],
            *[clean_text(item) for item in as_list(product.get("usage"))],
            *[clean_text(item) for item in as_list(product.get("sourceTexts"))],
            *[clean_text(item) for item in as_list(semantic.get("evidenceSentences"))],
        ]
    )
    for pattern in _SOURCE_REQUIRED_CONTEXTS:
        if pattern.search(text) and not pattern.search(corpus):
            return True
    return bool(
        _SOURCE_REQUIRED_GENERALIZATION.search(text)
        and not _SOURCE_REQUIRED_GENERALIZATION.search(corpus)
        or _SOURCE_REQUIRED_CAUSAL.search(text)
        and not _SOURCE_REQUIRED_CAUSAL.search(corpus)
    )


def _are_schema_descriptions_too_similar(webpage: str, product: str) -> bool:
    left, right = _description_role_key(webpage), _description_role_key(product)
    if not left or not right:
        return False
    if left == right:
        return True
    return (len(left) >= 72 and left in right) or (len(right) >= 72 and right in left)


def _description_role_key(value: str) -> str:
    words = _comparable_text(value)
    words = re.sub(
        r"\b(?:this|the|product|detail|page|pdp|introduces|introduce|summarizes|summarise|covers|presents|describes|includes|explains)\b",
        " ",
        words,
    )
    return " ".join(words.split())


def _webpage_description_contract_rejection(text: str, base: str, request: Mapping[str, Any]) -> str | None:
    """Keep an existing WebPage summary page-scoped without prescribing its prose."""

    if _has_page_viewpoint(base) and not _has_page_viewpoint(text):
        return "it no longer preserves the approved page-level viewpoint."
    product = as_dict(request.get("product"))
    brand = clean_text(product.get("brand"))
    if brand and _fact_appears_in_text(base, brand) and not _fact_appears_in_text(text, brand):
        return "it dropped the source-backed brand context present in the approved WebPage.description."
    unavailable_scope = _unavailable_webpage_scope(text, request)
    if unavailable_scope:
        return f"it claims {unavailable_scope} page coverage that is not present in the approved schema or product evidence."
    return None


def _has_page_viewpoint(value: str) -> bool:
    page_reference = re.search(
        r"\b(?:this|the|our|a)?\s*(?:product(?:[-\s]detail)?\s*)?page\b|\bpdp\b|"
        r"상품\s*페이지|제품\s*페이지|상세\s*페이지|商品ページ|製品ページ",
        value,
        re.I,
    )
    if page_reference:
        return True
    return bool(
        re.search(r"\b(?:here|on\s+site)\b|여기(?:에서|에)?|この(?:ページ|サイト)|こちら", value, re.I)
        and re.search(
            r"\b(?:faq(?:s)?|howto|how\s+to\s+use|usage|guidance|details?|information|reviews?)\b|"
            r"FAQ|사용법|사용\s*방법|안내|상세|정보|리뷰|口コミ|使い方|詳細",
            value,
            re.I,
        )
    )


def _unavailable_webpage_scope(value: str, request: Mapping[str, Any]) -> str | None:
    graph = _records(as_dict(as_dict(request.get("schemaMarkup")).get("jsonLd")).get("@graph"))
    if re.search(r"\b(?:HowTo|how\s+to\s+use|use\s+guidance|usage\s+(?:guidance|section|steps?))\b|사용법|사용\s*방법|使い方|使用方法", value, re.I) and not _find_node(graph, "HowTo"):
        return "HowTo/usage-direction"
    if re.search(r"\bFAQ(?:s)?\b|자주\s*묻는\s*질문|よくある質問", value, re.I) and not _find_node(graph, "FAQPage"):
        return "FAQ"
    reviews = as_dict(as_dict(request.get("product")).get("reviews"))
    has_reviews = bool(as_list(reviews.get("items"))) or reviews.get("reviewCount") is not None
    if re.search(r"customer\s+reviews?|reviews?|고객\s*리뷰|후기|カスタマーレビュー|口コミ", value, re.I) and not has_reviews:
        return "customer-review"
    return None


def _fact_appears_in_text(value: str, fact: str) -> bool:
    anchor = _compact_comparable_text(fact)
    return len(anchor) >= 2 and anchor in _compact_comparable_text(value)


def _faq_answer_contract_rejection(
    text: str, base: str, question: str, request: Mapping[str, Any]
) -> str | None:
    if _find_product_identity_position(text, request) < 0:
        return "the answer is no longer product-specific."
    relation_rejection = _unsupported_ingredient_benefit_relation_rejection(text, base, request)
    if relation_rejection:
        return relation_rejection
    product = as_dict(request.get("product"))
    semantic = as_dict(product.get("semanticFacts"))
    target_facts = _extract_target_role_fragments(f"{question} {base}")
    ingredient_facts = _unique_clean_texts(
        [
            *as_list(product.get("ingredients")),
            *as_list(semantic.get("ingredients")),
            *(as_dict(item).get("ingredient") for item in as_list(semantic.get("ingredientBenefitLinks"))),
        ]
    )
    benefit_facts = _unique_clean_texts(
        [
            *as_list(product.get("benefits")),
            *as_list(product.get("effects")),
            *as_list(semantic.get("benefits")),
            *as_list(semantic.get("effects")),
            *(
                as_dict(item).get(field)
                for item in as_list(semantic.get("ingredientBenefitLinks"))
                for field in ("benefit", "effect")
            ),
        ]
    )
    for role, facts in (
        ("target customer/concern", target_facts),
        ("ingredient/formula", ingredient_facts),
        ("benefit/effect", benefit_facts),
    ):
        if _find_fact_position(base, facts, -1, request) >= 0 and _find_fact_position(text, facts, -1, request) < 0:
            return f"the answer dropped the source-backed {role} needed for its matched FAQ intent."
    if _abandons_answered_topic(text, base, request):
        return "the answer no longer covers the topic the question was answered on."
    return None


def _abandons_answered_topic(text: str, base: str, request: Mapping[str, Any]) -> bool:
    product = as_dict(request.get("product"))
    identity = _meaningful_answer_tokens(
        " ".join(clean_text(product.get(field)) for field in ("name", "originalName", "brand", "category"))
    )
    base_topic = [
        token
        for token in _meaningful_answer_tokens(base)
        if not any(_shares_stem(token, entity) for entity in identity)
    ]
    if not base_topic:
        return False
    refined = _meaningful_answer_tokens(text)
    return not any(_shares_stem(topic, candidate) for topic in base_topic for candidate in refined)


def _meaningful_answer_tokens(value: str) -> list[str]:
    return [token for token in re.findall(r"[^\W_]+", clean_text(value), re.UNICODE) if len(token) >= 2]


def _shares_stem(left: str, right: str) -> bool:
    left_normalized, right_normalized = left.casefold(), right.casefold()
    return len(left_normalized) >= 2 and len(right_normalized) >= 2 and (
        left_normalized.startswith(right_normalized) or right_normalized.startswith(left_normalized)
    )


def _unsupported_ingredient_benefit_relation_rejection(
    text: str, approved_base: str, request: Mapping[str, Any]
) -> str | None:
    product = as_dict(request.get("product"))
    semantic = as_dict(product.get("semanticFacts"))
    ingredients = _ledger_confirmed_ingredient_names(product, semantic)
    for sentence in _split_public_sentences(text):
        for ingredient in ingredients:
            if not _ingredient_is_causal_in_text(sentence, ingredient):
                continue
            if _has_supported_ingredient_benefit_link(ingredient, sentence, approved_base, product, semantic):
                continue
            return (
                "it introduces an unsupported ingredient-benefit causal relationship "
                f"(an ingredient-to-benefit relation) for {_copy_truncate(ingredient, 80)!r}."
            )
    return None


def _ledger_confirmed_ingredient_names(product: Mapping[str, Any], semantic: Mapping[str, Any]) -> list[str]:
    """Return the designations the ledger itself fixes in the ingredient role.

    Extraction leaks outcomes, audiences, modifiers and whole sentences into the
    ingredient lists.  A designation the ledger also carries as an outcome or an
    audience is that fact, not an ingredient, and a sentence is an assertion
    rather than a name -- neither can stand on the ingredient side of a causal
    claim, so neither may demand an ingredient-benefit link.
    """

    other_roles = [
        value
        for value in _unique_clean_texts(
            [
                *as_list(product.get("benefits")),
                *as_list(product.get("effects")),
                *as_list(semantic.get("benefits")),
                *as_list(semantic.get("effects")),
                *as_list(semantic.get("skinTypes")),
                *(
                    as_dict(item).get(field)
                    for item in as_list(semantic.get("ingredientBenefitLinks"))
                    for field in ("benefit", "effect")
                ),
            ]
        )
        if _names_a_fact(value)
    ]
    declared = _unique_clean_texts(
        [
            *as_list(product.get("ingredients")),
            *as_list(semantic.get("ingredients")),
            *(as_dict(item).get("ingredient") for item in as_list(semantic.get("ingredientBenefitLinks"))),
        ]
    )
    return [
        ingredient
        for ingredient in declared
        if _names_a_fact(ingredient) and not any(_designates_the_same_fact(ingredient, role) for role in other_roles)
    ]


def _names_a_fact(value: str) -> bool:
    """Return whether a ledger entry names a thing instead of asserting a sentence."""
    return not is_complete_sentence(value) and is_atomic_fact_phrase(value)


def _designates_the_same_fact(left: str, right: str) -> bool:
    """Return whether two catalog designations name one and the same fact.

    Extraction also emits an outcome as ``[ingredient][outcome]`` run together,
    and reading that by containment would let the ingredient inside it excuse
    every causal claim about that ingredient.  Two designations name one fact
    only when they carry the same semantic tokens, not when one merely occurs
    inside the other.
    """
    left_tokens, right_tokens = _semantic_tokens(left), _semantic_tokens(right)
    return bool(left_tokens) and set(left_tokens) == set(right_tokens)


def _ingredient_is_causal_in_text(text: str, ingredient: str) -> bool:
    parts = re.findall(r"[^\W_]+", clean_text(ingredient), re.UNICODE)
    if not parts:
        return False
    anchor = r"[\s\-_/·]*".join(re.escape(part) for part in parts)
    outcome = (
        r"(?:돕|도움|개선|강화|회복|진정|완화|보습|수분|탄력|주름|보호|기여|제공|"
        r"helps?|supports?|improves?|strengthens?|restores?|soothes?|hydrates?|moisturi[sz]es?|"
        r"protects?|reduces?|delivers?|provides?|contributes?|改善|強化|回復|整え|支え|助け|保湿|うるお|鎮静|保護|寄与|提供)"
    )
    return bool(
        re.search(rf"{anchor}\s*(?:이|가|은|는)\s*[^.!?。！？]{{0,120}}{outcome}", text, re.I)
        or re.search(rf"{anchor}\s*(?:itself\s+)?[^.!?]{{0,32}}\b{outcome}", text, re.I)
        or re.search(rf"{anchor}\s*(?:が|は)\s*[^。！？]{{0,120}}{outcome}", text, re.I)
        or re.search(rf"(?:because\s+of|due\s+to|powered\s+by|thanks\s+to|덕분에|때문에|により|によって)\s*{anchor}", text, re.I)
    )


def _has_supported_ingredient_benefit_link(
    ingredient: str,
    candidate: str,
    approved_base: str,
    product: Mapping[str, Any],
    semantic: Mapping[str, Any],
) -> bool:
    for raw_link in as_list(semantic.get("ingredientBenefitLinks")):
        link = as_dict(raw_link)
        if not _link_covers_ingredient(link, ingredient):
            continue
        supported_outcome = " ".join(
            clean_text(link.get(field)) for field in ("benefit", "effect", "sentence", "sourceText")
        )
        if _has_meaningful_claim_overlap(candidate, supported_outcome, ingredient):
            return True

    sources = [
        approved_base,
        clean_text(product.get("description")),
        *[clean_text(value) for value in as_list(product.get("sourceTexts"))],
        *[clean_text(value) for value in as_list(semantic.get("evidenceSentences"))],
        *[
            clean_text(value)
            for item in as_list(product.get("faq"))
            for value in (as_dict(item).get("question"), as_dict(item).get("answer"))
        ],
        *[
            clean_text(value)
            for item in as_list(semantic.get("ingredientBenefitLinks"))
            for value in (as_dict(item).get("sentence"), as_dict(item).get("sourceText"))
        ],
    ]
    for source in sources:
        for source_sentence in _split_public_sentences(source):
            if not _states_the_designation(source_sentence, ingredient):
                continue
            if not _ingredient_is_causal_in_text(source_sentence, ingredient):
                continue
            if _has_meaningful_claim_overlap(candidate, source_sentence, ingredient):
                return True
    return False


def _has_meaningful_claim_overlap(candidate: str, evidence: str, ingredient: str) -> bool:
    ingredient_tokens = set(_semantic_tokens(ingredient))
    candidate_tokens = [
        token for token in _semantic_tokens(candidate) if token not in ingredient_tokens and not _relation_function_token(token)
    ]
    evidence_tokens = [
        token for token in _semantic_tokens(evidence) if token not in ingredient_tokens and not _relation_function_token(token)
    ]
    return any(_shares_stem(candidate_token, evidence_token) for candidate_token in candidate_tokens for evidence_token in evidence_tokens)


def _semantic_tokens(value: str) -> list[str]:
    return [
        re.sub(r"(?:에게|에서|으로|에는|부터|까지|하며|하고|하여|되는|합니다|됩니다|입니다|이다|을|를|이|가|은|는|의|에|와|과|도)$", "", token, flags=re.I).casefold()
        for token in _meaningful_answer_tokens(value)
        if len(token) >= 2
    ]


def _relation_function_token(value: str) -> bool:
    return bool(
        re.fullmatch(
            r"(?:도움|돕|개선|강화|회복|기여|제공|help|helps|support|supports|improve|improves|"
            r"strengthen|strengthens|provide|provides|product|제품|상품|ingredient|성분|配合|支え|改善|強化)",
            value,
            re.I,
        )
    )


def _link_covers_ingredient(link: Mapping[str, Any], ingredient: str) -> bool:
    """A link covers the designation it names and the parts its own evidence names.

    When the sentence that establishes the relation lists the ingredient inside
    the compound it credits, naming that part is a restatement of the ledger, not
    a new causal claim.
    """
    if _link_names_the_ingredient(clean_text(link.get("ingredient")), ingredient):
        return True
    evidence = " ".join(clean_text(link.get(field)) for field in ("sentence", "sourceText"))
    return _states_the_designation(evidence, ingredient)


def _states_the_designation(value: str, designation: str) -> bool:
    """Return whether a text names a designation whole, not as part of another name.

    ``베타`` occurs inside ``베타인`` and ``Beta`` inside ``Betaine``, so reading
    the evidence by substring would let a name that the ledger never linked
    borrow the support of the name that contains it.  A designation is named
    only where the evidence carries each of its tokens as a token of its own,
    allowing for the particle Korean attaches to one.
    """
    stated = {
        token
        for word in _semantic_tokens(value)
        for token in (word, strip_korean_particle(word))
        if len(token) >= 2
    }
    tokens = _semantic_tokens(designation)
    return bool(tokens) and all(token in stated for token in tokens)


def _link_names_the_ingredient(link_ingredient: str, ingredient: str) -> bool:
    """Return whether a link's own ingredient field designates the ingredient under test.

    Two short catalog names must not match because one occurs inside the other:
    ``베타`` sits inside ``베타인`` and ``Beta`` inside ``Betaine``, and reading
    that as the same ingredient hands an unlinked name the support of the name
    that contains it.  The same name spelled differently, and the same name
    under another head noun, are still one ingredient.
    """
    left, right = _compact_comparable_text(link_ingredient), _compact_comparable_text(ingredient)
    if not left or not right:
        return False
    return left == right or _shares_qualified_designation(link_ingredient, ingredient)


def _shares_qualified_designation(left: str, right: str) -> bool:
    """Two designations carrying the same qualifiers name one thing under another head."""
    left_tokens, right_tokens = _semantic_tokens(left), _semantic_tokens(right)
    if len(left_tokens) < 3 or len(left_tokens) != len(right_tokens):
        return False
    return left_tokens[:-1] == right_tokens[:-1] and left_tokens[-1] != right_tokens[-1]


def _is_source_supported(text: str, request: Mapping[str, Any], published: str = "") -> bool:
    product = as_dict(request.get("product"))
    scoped_evidence = _records(request.get("_faqScopedEvidence"))
    if scoped_evidence:
        corpus = " ".join(
            [
                clean_text(product.get("name")),
                clean_text(product.get("originalName")),
                clean_text(product.get("brand")),
                *(clean_text(item.get("text")) for item in scoped_evidence),
            ]
        )
        return _states_no_unsupported_fact(text, corpus, published)
    reviews = as_dict(product.get("reviews"))
    corpus = " ".join(
        [
            clean_text(product.get("name")),
            clean_text(product.get("brand")),
            clean_text(product.get("description")),
            *[clean_text(item) for item in as_list(product.get("benefits"))],
            *[clean_text(item) for item in as_list(product.get("effects"))],
            *[clean_text(item) for item in as_list(product.get("ingredients"))],
            *[clean_text(item) for item in as_list(product.get("usage"))],
            *[clean_text(item) for item in as_list(product.get("sourceTexts"))],
            *[clean_text(item) for item in as_list(reviews.get("keywords"))],
            *[clean_text(as_dict(item).get("body")) for item in as_list(reviews.get("items"))],
            str(as_dict(request.get("content")).get("sections") or ""),
        ]
    )
    return _states_no_unsupported_fact(text, corpus, published)


def _states_no_unsupported_fact(text: str, corpus: str, published: str) -> bool:
    """Return whether every fact the text states stands on evidence already held.

    A clause states one fact, so that is the unit this judgment reads.  Measured
    over a whole description instead, a fixed proportion of unsupported words
    grows with the text: the same invented efficacy that a sentence rejects
    rides along in a paragraph, because nine unsupported words are one fifth of
    forty-eight.

    Copy the refinement is rewriting already passed these gates when it was
    written, so the words it carries are not new facts.  Counting them as new
    is what made the renderer's own connective vocabulary -- 주요, 기술,
    고객들, 언급 -- read as unsupported product claims, and holding the
    published copy as evidence tells those apart without a list of Korean
    function words to keep in step with the renderer.
    """

    supported = {
        token.casefold()
        for source in (corpus, published)
        for token in _meaningful_tokens(source)
    } | _ALLOWED_COPY_WORDS
    for clause in split_into_clauses(text) or [text]:
        novel = {token.casefold() for token in _meaningful_tokens(clause)} - supported
        if len(novel) > _UNSUPPORTED_WORDS_PER_FACT:
            return False
    return True


# One word in a clause can be an artifact rather than a claim: a compound the
# page writes closed and the copy writes open (``시험결과`` beside ``결과``), or
# a function word no closed-class list happens to carry.  Two independent words
# that neither the sources nor the published copy hold are not an artifact --
# they are a fact the page does not have.  The allowance is per stated fact,
# which is the whole point: as a proportion of a whole description it would
# grow with the text and admit the claim a sentence rejects.
_UNSUPPORTED_WORDS_PER_FACT = 1


_ALLOWED_COPY_WORDS = frozenset(
    {
        "a",
        "an",
        "the",
        "is",
        "are",
        "for",
        "with",
        "and",
        "or",
        "this",
        "that",
        "product",
        "page",
        "official",
        "designed",
        "suitable",
        "serum",
        "cream",
        "toner",
        "skin",
        "dry",
        "sensitive",
    }
)


def _apply_property_refinements(
    product: dict[str, Any] | None,
    result: Mapping[str, Any],
    request: Mapping[str, Any],
    rejections: list[dict[str, str]],
) -> tuple[bool, list[str], list[dict[str, str]]]:
    if product is None:
        return False, [], []
    changes = as_dict(result.get("schemaProperties"))
    properties_value = product.get("additionalProperty")
    if not isinstance(properties_value, list):
        return False, [], []
    properties = _records(cast(object, properties_value))
    product["additionalProperty"] = properties
    warnings: list[str] = []
    evidence: list[dict[str, str]] = []
    changed = False
    by_name: dict[str, dict[str, Any]] = {clean_text(item.get("name")): item for item in properties}
    for name, raw_value in changes.items():
        normalized_name = clean_text(name)
        if normalized_name not in _REFINABLE_SCHEMA_PROPERTY_NAMES:
            continue
        current = by_name.get(normalized_name)
        if current is None:
            continue
        accepted = _accept_text(
            raw_value,
            clean_text(current.get("value")),
            f"Product.additionalProperty.{normalized_name}",
            request,
            minimum=12,
        )
        if accepted.error:
            warnings.append(accepted.error)
            rejections.append(
                {
                    "field": f"Product.additionalProperty.{normalized_name}",
                    "reason": accepted.error,
                    "rejectedText": clean_text(raw_value),
                }
            )
            continue
        property_rejection = (
            _schema_property_value_rejection(
                normalized_name, accepted.text, clean_text(current.get("value")), request
            )
            if accepted.text
            else None
        )
        if property_rejection:
            reason = (
                f"Product.additionalProperty.{normalized_name} refinement rejected because {property_rejection}"
            )
            warnings.append(reason)
            rejections.append(
                {
                    "field": f"Product.additionalProperty.{normalized_name}",
                    "reason": reason,
                    "rejectedText": accepted.text or "",
                }
            )
            continue
        if accepted.text and accepted.text != current.get("value"):
            before = clean_text(current.get("value"))
            current["value"] = accepted.text
            evidence.append(
                {
                    "field": f"schema.Product.additionalProperty.{name}",
                    "source": "llm",
                    "value": _summary(before, accepted.text),
                }
            )
            changed = True
    return changed, warnings, evidence


def _schema_property_value_rejection(name: str, value: str, before: str, request: Mapping[str, Any]) -> str | None:
    """Return a field-level reason when a public PropertyValue changes claim scope."""

    if _contains_analysis_label(value):
        return "it exposes an analysis label."
    if re.search(r"[가-힣]", before) and not is_korean_complete_sentence(before):
        if is_korean_complete_sentence(value):
            return "it changes a Korean fragment into a new sentence-level claim."
        if not is_separator_joined_list(before) and korean_phrase_head_token(value) != korean_phrase_head_token(before):
            return "it does not preserve the Korean property phrase role."
    if name == "Usage" and not is_procedural_usage_instruction(value):
        return "it no longer contains a usage action."
    if name == "Key ingredients and technologies" and not re.search(
        r"(?:ingredient|technology|formula|complex|capsule|peptide|ceramide|retinol|"
        r"성분|기술|포뮬러|복합체|캡슐|펩타이드|세라마이드|레티놀)",
        value,
        re.I,
    ):
        return "it no longer identifies an ingredient, technology, or formula."
    if name == "Brand science" and re.search(
        r"(?:apply|use|massage|pat|spread|사용|바르|도포|마사지|흡수)", value, re.I
    ) and not re.search(
        r"(?:ingredient|technology|formula|complex|capsule|peptide|ceramide|retinol|"
        r"성분|기술|포뮬러|복합체|캡슐|펩타이드|세라마이드|레티놀)",
        value,
        re.I,
    ):
        return "it changes brand science into an unsupported usage instruction."
    if name == "Target customer" and not _is_source_supported(value, request, before):
        return "its target-customer wording is not supported by product evidence."
    if relation_rejection := _unsupported_ingredient_benefit_relation_rejection(value, before, request):
        return relation_rejection
    if _introduces_unsupported_context_association(value, request):
        return "it promotes an unsupported routine, timing, or contextual association into public copy."
    return None


def _apply_faq_refinements(
    graph: Sequence[dict[str, Any]],
    result: Mapping[str, Any],
    request: Mapping[str, Any],
    rejections: list[dict[str, str]],
) -> tuple[bool, list[str], list[dict[str, str]]]:
    candidates = as_list(result.get("faqAnswers"))
    if not candidates:
        return False, [], []
    faq = _find_node(graph, "FAQPage")
    entities_value = faq.get("mainEntity") if faq else None
    if not isinstance(entities_value, list):
        reason = "FAQ refinement rejected because no canonical FAQPage exists."
        rejections.append({"field": "FAQPage.mainEntity", "reason": reason})
        return False, [reason], []
    entities = _records(cast(object, entities_value))
    if faq is not None:
        faq["mainEntity"] = entities
    membership, membership_error = _faq_membership_for_entities(request, entities)
    if membership_error:
        reason = f"FAQ refinement rejected because {membership_error}"
        rejections.append({"field": "FAQPage.mainEntity", "reason": reason})
        return False, [reason], []
    if membership is not None:
        expected_ids = [clean_text(item.get("id")) for item in membership]
        candidate_ids = [clean_text(as_dict(item).get("id")) for item in candidates]
        if len(candidates) != len(membership) or candidate_ids != expected_ids:
            reason = (
                "FAQ refinement rejected because it did not return the complete immutable FAQ membership in its "
                "original order."
            )
            rejections.append({"field": "FAQPage.mainEntity", "reason": reason})
            return False, [reason], []
    by_question = {_comparable_text(clean_text(item.get("name"))): index for index, item in enumerate(entities)}
    changed = False
    warnings: list[str] = []
    evidence: list[dict[str, str]] = []
    matched_order: list[int] = []
    corrective_pass = bool(as_list(request.get("refinementFeedback")))
    for item_index, raw in enumerate(candidates):
        candidate = as_dict(raw)
        if membership is not None:
            matched_index = item_index
            row_membership = membership[item_index]
            row_id = clean_text(row_membership.get("id"))
            row_evidence = _faq_membership_evidence(request, row_membership)
            row_request = _faq_scoped_request(request, row_evidence)
        else:
            source_question = clean_text(candidate.get("sourceQuestion")) or clean_text(candidate.get("question"))
            matched_index = by_question.get(_comparable_text(source_question)) if source_question else item_index
            row_id = ""
            row_evidence = []
            row_request = request
        if not isinstance(matched_index, int) or not 0 <= matched_index < len(entities):
            entity = None
        else:
            entity = entities[matched_index]
        answer = as_dict(entity.get("acceptedAnswer")) if entity else {}
        if entity is None or not answer:
            reason = "FAQ refinement rejected because it did not map to an existing FAQ question."
            if not corrective_pass:
                warnings.append(reason)
            continue
        assert isinstance(matched_index, int)
        if matched_index in matched_order:
            continue
        before_question = clean_text(entity.get("name"))
        before_answer = clean_text(answer.get("text"))
        if candidate.get("question") is None or candidate.get("answer") is None:
            reason = (
                f"FAQPage.mainEntity.{matched_index + 1} refinement rejected because a refined FAQ must provide "
                "the question and answer together."
            )
            warnings.append(reason)
            rejections.append(
                {
                    "field": f"FAQPage.mainEntity.{matched_index + 1}",
                    "reason": reason,
                    "rejectedText": json.dumps(candidate, ensure_ascii=False),
                }
            )
            continue
        accepted_question = _accept_faq_question(
            candidate.get("question"), before_question, matched_index, row_request, row_evidence
        )
        accepted_answer = _accept_text(
            candidate.get("answer"),
            before_answer,
            f"FAQPage.mainEntity.{matched_index + 1}.acceptedAnswer",
            row_request,
            minimum=24,
        )
        if accepted_question.error or accepted_answer.error:
            warnings.extend(item for item in (accepted_question.error, accepted_answer.error) if item)
        if accepted_question.error:
            rejections.append(
                {
                    "field": f"FAQPage.mainEntity.{matched_index + 1}.name",
                    "reason": accepted_question.error,
                    "rejectedText": clean_text(candidate.get("question")),
                    **({"faqRowId": row_id} if row_id else {}),
                }
            )
        if accepted_answer.error:
            rejections.append(
                {
                    "field": f"FAQPage.mainEntity.{matched_index + 1}.acceptedAnswer",
                    "reason": accepted_answer.error,
                    "rejectedText": clean_text(candidate.get("answer")),
                    **({"faqRowId": row_id} if row_id else {}),
                }
            )
        if accepted_question.error or accepted_answer.error:
            continue
        next_question = accepted_question.text or before_question
        next_answer = accepted_answer.text or before_answer
        if next_question != before_question or next_answer != before_answer:
            answer_rejection = _faq_answer_contract_rejection(
                next_answer,
                before_answer,
                next_question,
                row_request,
            )
            if answer_rejection is None and row_evidence:
                answer_rejection = _faq_membership_evidence_rejection(
                    next_question, next_answer, row_evidence, row_request
                )
            if answer_rejection:
                reason = f"FAQPage.mainEntity.{matched_index + 1} refinement rejected because {answer_rejection}"
                warnings.append(reason)
                rejections.append(
                    {
                        "field": f"FAQPage.mainEntity.{matched_index + 1}",
                        "reason": reason,
                        "rejectedText": json.dumps(candidate, ensure_ascii=False),
                        **({"faqRowId": row_id} if row_id else {}),
                    }
                )
                continue
        matched_order.append(matched_index)
        if next_question != before_question:
            entity["name"] = next_question
            evidence.append(
                {
                    "field": f"schema.FAQPage.mainEntity.{matched_index + 1}.name",
                    "source": "llm",
                    "value": _summary(before_question, next_question),
                    **({"faqRowId": row_id} if row_id else {}),
                }
            )
            changed = True
        if next_answer != before_answer:
            answer["text"] = next_answer
            entity["acceptedAnswer"] = answer
            evidence.append(
                {
                    "field": f"schema.FAQPage.mainEntity.{matched_index + 1}.acceptedAnswer",
                    "source": "llm",
                    "value": _summary(before_answer, next_answer),
                    **({"faqRowId": row_id} if row_id else {}),
                }
            )
            changed = True
    if membership is None and matched_order and not corrective_pass:
        order = [*matched_order, *[index for index in range(len(entities)) if index not in matched_order]]
        if order != list(range(len(entities))):
            entities[:] = [entities[index] for index in order]
            evidence.append(
                {
                    "field": "schema.FAQPage.mainEntity",
                    "source": "llm",
                    "value": "FAQ items were reordered by inferred generative-search question intent.",
                }
            )
            changed = True
    return changed, warnings, evidence


def _faq_membership_for_entities(
    request: Mapping[str, Any], entities: Sequence[Mapping[str, Any]]
) -> tuple[list[dict[str, Any]] | None, str | None]:
    """Return the immutable FAQ membership sidecar or a structural error.

    The sidecar is produced by the model-plan renderer.  It intentionally
    carries identity and evidence only; prose stays with the AI-authored FAQ
    rows.  Calls without it are legacy/direct-library compatibility paths.
    """

    if "faqMembership" not in request:
        return None, None
    rows = [as_dict(item) for item in as_list(request.get("faqMembership"))]
    if len(rows) != len(entities):
        return [], "its stable row count did not match the canonical FAQPage."
    evidence_ids = {
        clean_text(item.get("id"))
        for item in _records(request.get("evidenceLedger"))
        if clean_text(item.get("id"))
    }
    stable: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, row in enumerate(rows):
        identifier = clean_text(row.get("id"))
        scoped_ids = _unique_strings(as_list(row.get("evidenceIds")))
        if not identifier or identifier in seen:
            return [], "it contained a missing or duplicate stable FAQ row id."
        if not scoped_ids or any(item not in evidence_ids for item in scoped_ids):
            return [], f"row {index + 1} did not have valid evidence IDs."
        seen.add(identifier)
        stable.append({**row, "id": identifier, "evidenceIds": scoped_ids})
    return stable, None


def _faq_membership_evidence(request: Mapping[str, Any], membership: Mapping[str, Any]) -> list[dict[str, Any]]:
    selected_ids = {clean_text(item) for item in as_list(membership.get("evidenceIds")) if clean_text(item)}
    return [item for item in _records(request.get("evidenceLedger")) if clean_text(item.get("id")) in selected_ids]


def _faq_scoped_request(request: Mapping[str, Any], evidence: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    return {**request, "_faqScopedEvidence": [dict(item) for item in evidence]}


def _faq_membership_evidence_rejection(
    question: str,
    answer: str,
    evidence: Sequence[Mapping[str, Any]],
    request: Mapping[str, Any],
) -> str | None:
    if not _faq_question_has_scoped_support(question, evidence, request):
        return "the rewritten question was not supported by this FAQ row's assigned evidence."
    for sentence in _split_public_sentences(answer):
        if not sentence_evidence_has_direct_claim_support(sentence, evidence):
            return "the rewritten answer included a sentence outside this FAQ row's assigned evidence."
    return None


def _faq_question_has_scoped_support(
    question: str, evidence: Sequence[Mapping[str, Any]], request: Mapping[str, Any]
) -> bool:
    if not question.rstrip().endswith(("?", "？")) or _find_product_identity_position(question, request) < 0:
        return False
    if sentence_evidence_has_direct_claim_support(question, evidence):
        return True
    identity_tokens = {
        token.casefold()
        for token in _meaningful_tokens(
            " ".join(clean_text(as_dict(request.get("product")).get(field)) for field in ("name", "originalName", "brand"))
        )
    }
    query_frame_tokens = {
        "what", "which", "who", "when", "where", "why", "how", "can", "could", "should", "would", "does",
        "is", "are", "the", "a", "an", "for", "with", "and", "or", "care", "option", "relevant", "best",
        "right", "good", "choose", "choice", "routine", "product", "skin", "제품", "상품", "어떤", "무엇",
        "어떻게", "좋은", "맞는", "추천", "케어", "사용", "고민",
    }
    question_tokens = {
        token.casefold()
        for token in _meaningful_tokens(question)
        if token.casefold() not in identity_tokens | query_frame_tokens
    }
    source_tokens = {
        token.casefold() for item in evidence for token in _meaningful_tokens(clean_text(item.get("text")))
    }
    return bool(question_tokens & source_tokens)


def _comparable_text(value: str) -> str:
    return " ".join(re.findall(r"[A-Za-z0-9가-힣]+", value.casefold()))


def _accept_faq_question(
    candidate: object,
    current: str,
    index: int,
    request: Mapping[str, Any],
    scoped_evidence: Sequence[Mapping[str, Any]] = (),
) -> _AcceptedText:
    if candidate is None:
        return _AcceptedText()
    text = clean_proposed_text(str(candidate))
    field = f"FAQPage.mainEntity.{index + 1}.name"
    if not text:
        return _AcceptedText(error=f"{field} refinement rejected because it was empty.")
    if text == current:
        return _AcceptedText()
    if len(text) < 8 or len(text) > 200:
        return _AcceptedText(error=f"{field} refinement rejected because its length was outside the public-copy contract.")
    if _contains_analysis_label(text):
        return _AcceptedText(error=f"{field} refinement rejected because it exposes an analysis label.")
    if not _is_source_supported(text, request, current) and not _faq_question_has_scoped_support(
        text, scoped_evidence, request
    ):
        return _AcceptedText(error=f"{field} refinement rejected because its factual tokens were not supported by the product evidence.")
    product = as_dict(request.get("product"))
    identity = (clean_text(product.get("name")), clean_text(product.get("originalName")), clean_text(product.get("brand")))
    if any(identity) and not any(term and _comparable_text(term) in _comparable_text(text) for term in identity):
        return _AcceptedText(error=f"{field} refinement rejected because the rewritten question is no longer specific to this product or brand.")
    return _AcceptedText(text=text)


def _find_node(graph: Sequence[dict[str, Any]], kind: str) -> dict[str, Any] | None:
    for node in graph:
        types = node.get("@type")
        if types == kind or isinstance(types, list) and kind in types:
            return node
    return None


def _faq_section(graph: Sequence[dict[str, Any]]) -> str:
    faq = _find_node(graph, "FAQPage")
    rows: list[str] = []
    for item in _records(faq.get("mainEntity") if faq else None):
        answer = as_dict(item.get("acceptedAnswer"))
        if clean_text(item.get("name")) and clean_text(answer.get("text")):
            rows.append(f"Q. {item['name']}\nA. {answer['text']}")
    return "\n\n".join(rows)


def _records(value: object) -> list[dict[str, Any]]:
    return [as_dict(item) for item in as_list(value) if as_dict(item)]


def _meaningful_tokens(value: str) -> list[str]:
    """Return the content words a text states, each read by its own measure.

    A Korean word carries its grammatical role on its own stem, so the same
    word is spelled differently wherever it stands -- ``개인차`` in a source
    footnote and ``개인차가`` as a subject, ``세정`` in a phrase and
    ``세정합니다`` in a sentence.  Comparing the spellings counts a particle as
    a new fact, which is why natural Korean read as if it asserted something
    its source never said.

    Reading the stems under the length floor written for English deletes them
    instead: two syllables is a whole Korean word (주름, 미백, 개선) where two
    letters is not an English one, so an unsupported claim disappeared from the
    comparison entirely.  Each side is therefore measured on its own terms.
    """

    tokens: list[str] = []
    for token in re.findall(r"[A-Za-z가-힣0-9]+", value):
        if re.search(r"[가-힣]", token):
            stem = strip_korean_inflection(token)
            if len(stem) >= 2 and not stem.isdigit():
                tokens.append(stem)
        elif len(token) > 2 and not token.isdigit():
            tokens.append(token)
    return tokens


def _summary(before: str, after: str) -> str:
    return f"Refined public copy from {before[:80]!r} to {after[:80]!r}."


def _merge_usage(first: object, second: object) -> object:
    return merge_token_usage(first, second)


def _unique_strings(values: Sequence[object]) -> list[str]:
    result: list[str] = []
    for value in values:
        text = str(value).strip()
        if text and text not in result:
            result.append(text)
    return result


refinePdpGeoCopy = refine_pdp_geo_copy
isVolumeOrLabelOnlyReviewText = is_volume_or_label_only_review_text
refinementDropsPublishedMeasurement = refinement_drops_published_measurement
refinementStatesUnpublishedMeasurement = refinement_states_unpublished_measurement

__all__ = [
    "ModelBackedCopyRefiner",
    "is_volume_or_label_only_review_text",
    "isVolumeOrLabelOnlyReviewText",
    "pdp_geo_copy_refinement_json_schema",
    "refine_pdp_geo_copy",
    "refinePdpGeoCopy",
    "resolve_copy_refiner",
    "refinement_drops_published_measurement",
    "refinement_states_unpublished_measurement",
    "refinementDropsPublishedMeasurement",
    "refinementStatesUnpublishedMeasurement",
]
