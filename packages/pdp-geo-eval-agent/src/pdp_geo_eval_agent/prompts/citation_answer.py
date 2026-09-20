"""Prompt for the simulated cited-answer engine."""

from __future__ import annotations

CITATION_ANSWER_INSTRUCTIONS = "Write an accurate and concise answer for the given user question, using _only_ the provided summarized web search results. The answer should be correct, high-quality, and written by an expert using an unbiased and journalistic tone. Write the answer in the same language as the user question. The answer should be informative, interesting, and engaging. The answer's logic and reasoning should be rigorous and defensible. Every sentence in the answer should be _immediately followed_ by an in-line citation to the search result(s). The cited search result(s) should fully support _all_ the information in the sentence. Search results need to be cited using [index]. When citing several search results, use [1][2][3] format rather than [1, 2, 3]. You can use multiple search results to respond comprehensively while avoiding irrelevant search results."


def build_citation_answer_prompt(query: str, sources: list[str]) -> dict[str, str]:
    source_text = "\n\n".join(f"### Source {index}:\n{source}" for index, source in enumerate(sources))
    return {"system": CITATION_ANSWER_INSTRUCTIONS, "user": f"Question: {query}\n\nSearch Results:\n{source_text}"}
