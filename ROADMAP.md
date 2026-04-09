# User Feedback Roadmap

Updated: 2026-04-09

## Completed

- P0: default independent answers, tighter grounding, multilingual retrieval normalized to Chinese-first search, definition-style queries boosted.
- P1: follow-up mode switch added and defaulted off.
- P1: citation cards added to the chat answer area.
- P1: answer style tightened further to reduce self-referential wording and unsupported free-form expansion.
- P2: each answer now ends with 3 grounded follow-up questions before the references section.

## Remaining

### P1

- Document weighting controls.
  Make core texts such as `道德经`, `阴符经`, `双经和一`, `修德通真论`, `解缘道根`, `玉真通解` rank ahead of lower-priority materials during retrieval.

- Citation display phase 2.
  Add stronger linkage between inline citation numbers and evidence cards, support expanding full chunks, and show chapter or section labels when they can be derived reliably.

### P2

- Multilingual answer enhancement.
  For non-Chinese answers, keep key Chinese terms inline, and add optional pinyin where helpful for domain-specific terminology.

- Controlled terminology translation.
  Add a glossary or keyword constraint layer so the same core concept is translated consistently across English, French, German, and Spanish.

- Homepage fixed questions / prompt presets.
  Expose an interface or config for rotating curated starter questions on the first screen.

- Usage analytics.
  Show query volume and high-frequency question stats for operations review.

- Concurrency and stuck-response optimization.
  Reduce timeout, waiting, and retry cases when multiple users query at the same time.

- Additional document ingestion workflow.
  Support the next batch of standalone Word documents and make the import path easier to repeat.
