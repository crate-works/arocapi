# 2. The library enforces access through one access function

Date: 2026-10-14

## Status

Accepted

## Context

An entity's data comes in three levels: its Record, its Metadata and, for
files, its Content (see `GLOSSARY.md`). Visibility guards the Record and is
enforced by the library (ADR 0001). Access guards Metadata and Content.

If access were only a signal, every consumer would have to repeat its access
rule in its handlers, and a consumer that didn't would serve restricted
Metadata and Content to everyone. Deciding access and reshaping responses are
separate jobs: keeping them apart stops the access layer redacting the Record.
Every file is an entity with its own licences, so file access needs no rule of
its own.

## Decision

- Each level has exactly one guard. The Record is guarded only by visibility:
  a request sees all of it or none of it, and the library never redacts it.
  Metadata is guarded by `access.metadata`, Content by `access.content`.
- Consumers supply one access function, called with an entity, that returns
  only access: `metadata`, `content` and the optional authorisation URLs. The
  library attaches the result. A file's access is its file entity's access.
- The access function receives the entity's Record fields with `memberOf` and
  `rootCollection` as ids, not resolved to names, so enforcing access costs no
  query beyond the visibility lookup.
- The library enforces it. `/entity/:id/metadata` is Denied when
  `access.metadata` is false, `/file/:id` when the file entity's
  `access.content` is false, for GET and HEAD, before the storage backend is
  called. Storage backends only deliver bytes.
- Denied requests get a 401 if anonymous and a 403 otherwise, as HTTP
  defines them. Consumers only state whether a request is authenticated
  (`isAuthenticated`); without it the repository has no logins and every
  refusal is a 403. Never 404: the entity is visible. The body is the spec's
  error envelope; clients take authorisation URLs from the access signal, not
  the error.
- `access.content` on a collection or object is a signal only; only files have
  Content to enforce.
- A licence-based helper derives access from an entity's metadata and content
  licences, checking each licence once per request.

## Consequences

- Clients should check `access.metadata` before fetching Metadata, rather
  than fetching it alongside the entity and handling a Denied response.
- Each Metadata or Content request costs one access call. Remote checks
  (e.g. REMS) should be cached per request, as the licence helper does.
- Serving a redacted RO-Crate to a request without Metadata access is not
  supported; a consumer wanting that grants `access.metadata` and redacts in
  its own Metadata half.
