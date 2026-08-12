# Spec — English source, translated on delivery

## Requirement: display strings are written once, in English

`HOOK_CONTEXT_TYPES[].label` and `TRIGGER_LABELS` hold English source text.

### Scenario: a sixth category is added

- **WHEN** someone adds an entry to `HOOK_CONTEXT_TYPES`
- **THEN** a label containing CJK characters fails `tests/hook-context-five-categories.test.js`

The failure mode is not a bad translation. It is someone writing the new name in the language
they happen to be speaking — which is what v1.26.151 did, and it passed a full suite.

## Requirement: the rendered line instructs the model to translate it

### Scenario: the user is speaking Chinese

- **WHEN** `renderHookContextLine` returns a line
- **THEN** it is followed by an instruction to relay it, translated into the user's language

### Scenario: the numbers must not be paraphrased

- **WHEN** that instruction is rendered
- **THEN** it names the counts and the version tag as things to keep exactly as written

Without that, a model summarises the numbers away. They are the entire point of the line:
`Preferences 0` is the sentence the old display could not form, and a paraphrase that drops it
puts the display back where it started.

## Requirement: the fallback output is unchanged

### Scenario: an un-upgraded server

- **WHEN** `/hook-context` is unavailable and the hook renders the legacy banner
- **THEN** its existing Chinese text is emitted exactly as before

Users on that path have been reading it all along. Translating it too would turn a degraded
path into a third variant nobody asked for.

## Requirement: the new path does not repeat itself

### Scenario: a deploy with matching iron rules

- **WHEN** the new response shape is rendered with rules to list
- **THEN** the listing is not preceded by a second banner naming the trigger and the count

The counts line above it already reads `Iron rules N` and already carries the instruction.
