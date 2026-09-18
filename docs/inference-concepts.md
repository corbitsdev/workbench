# Inference concept vocabulary

Design notes for `@corbits/inference-catalog`'s `concepts.ts`, the words an
agent uses to ask for a model.

## Why plain data, not a table

Pure data with no branching or network — the `CATALOG_SEEDS` idiom — so it's
importable on its own. It's deliberately not a table: this is product
vocabulary that ships with the build and needs to be reviewable in a diff. A
bench deviates through its policy row's concept ceilings and allow/deny
lists, never by forking the vocabulary.

## Ceilings

USD per million tokens, input and output kept separate — a blended number
would hide which axis a workload actually spends on. Ceilings are soft by
default: a model over ceiling is flagged and sorted last, not dropped, so a
bench whose only provider is expensive still gets an answer.

## Capabilities vs. reference mix

Capabilities are `@intx/types`' vocabulary — narrower than the pinned
catalog's, since `long-context` and `prompt-caching` are baked onto catalog
offerings but aren't storable capability values. Where a concept wants
"handles a huge input," its reference mix carries that meaning instead: a
10M-token input mix ranks the model that's cheap on enormous inputs first,
which is the decision the capability would have stood in for.
