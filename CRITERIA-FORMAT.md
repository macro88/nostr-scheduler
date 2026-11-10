# Criteria file format

Each profile has one criteria file. The file is the brief a suggester reads before it proposes a post, and the store validates it before the app uses it.

## Why Markdown with YAML front matter

The format is a Markdown file with a YAML front matter block, plus a sibling YAML file for the feedback log.

Structured limits (cadence, topics, post types, sources) belong in the front matter, where a schema can check types and required fields. Voice, reply rules, and examples are prose, and Markdown is the natural place to edit them.

A single YAML file would parse more uniformly, but the brief would be worse to read and edit. A Markdown-only file without front matter would bury the typed fields in headings and leave the loader guessing.

The feedback log is a sibling file, not a section of the brief, so daily decisions do not churn the document you edit.

## File layout

```
data/criteria/<profile-id>.md
data/criteria/<profile-id>.feedback.yaml
```

An example brief is in `examples/criteria/example-profile.md`.

## Front matter

All of the following fields are required unless marked otherwise.

```yaml
---
profile_id: example
version: "1"
timezone: Asia/Hong_Kong
posts_per_day: 1
preferred_hours: [9, 18]
post_types: [note, thread, reply]
topics:
  - example topic
no_go_topics:
  - example no-go topic
sources:
  - example source
---
```

- `profile_id` must match the profile this file is attached to when the app loads it for that profile.
- `version` is a string the feedback log can refer to.
- `timezone` is an IANA time zone name.
- `posts_per_day` is a non-negative number. It is a target, not a cap the app enforces in v1.
- `preferred_hours` is a list of hours in that time zone, each an integer from 0 to 23. It may be empty.
- `post_types` is a non-empty list whose entries are `note`, `thread`, or `reply`.
- `topics` and `no_go_topics` are lists of strings. Either list may be empty.
- `sources` lists feeds, people, or places a suggester may draw on. It may be empty.

Unknown front-matter keys are an error. The loader does not ignore them.

## Body headings

The body must contain these headings, in any order, each used once.

- `Voice`
- `Reply rules`
- `Good examples`
- `Bad examples`

Other headings are an error in v1, so the parser can stay strict. Use lists or short paragraphs under each heading. Good and bad examples should be written as the post would appear, not as a description of a post, unless you are explaining why a bad example fails.

## Feedback log

`data/criteria/<profile-id>.feedback.yaml` is append-only. The app writes a new entry when you approve, edit, or reject a suggestion, and when a queued post is marked missed. The store checks that older entries still match after the write.

```yaml
entries:
  - at: 1762740000
    suggestion_id: sug_01
    action: rejected
    note: Too close to a no-go topic.
    criteria_version: "1"
```

`action` is one of `approved`, `edited`, `rejected`, or `missed`. `note` may be empty. Suggesters read this log through `get_criteria`, together with the brief.

## Validation

The store parses front matter and headings into a criteria value. A file that is missing a required field, has an empty `post_types` list, uses an unknown post type, or fails to parse as Markdown with YAML front matter is rejected at the boundary and is not used. The error names the field.
